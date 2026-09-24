"""FastAPI application: multi-user REST + WebSocket API for Tranding-track.

Multi-tenant design: anyone can self-sign-up, but an account must be LICENSED by
the administrator before it can configure exchange keys or trade. Each user
brings their OWN trade-only Binance keys (stored encrypted at rest) and gets
their own in-memory :class:`TradingEngine` and a unique TradingView webhook URL.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

import pandas as pd
from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import __version__
from app.backtest import run_backtest
from app.config import get_settings
from app.database import get_db, init_db
from app.deps import get_current_user, require_admin, require_licensed_user
from app.models import (
    LicenseStatus,
    SignalLog,
    Trade,
    TradeStatus,
    User,
    UserRole,
)
from app.schemas import (
    BotStatus,
    CredentialsUpdate,
    ExecutionResult,
    LicenseUpdate,
    LoginRequest,
    ManualOrder,
    MeOut,
    SettingsOut,
    SettingsUpdate,
    SignalOut,
    SignupRequest,
    TickerOut,
    TokenResponse,
    TradeOut,
    TradingViewSignal,
    UserOut,
)
from app.security import (
    create_access_token,
    encrypt_secret,
    hash_password,
    new_webhook_token,
    secrets_enabled,
    verify_password,
)
from app.usermgr import get_manager
from app.learn import PARAM_GRIDS, train
from app.analysis import MarketAnalyzer
from app.strategies import STRATEGY_REGISTRY, build_strategy
from app.tasks import monitor_loop
from app.ws import Broadcaster
from app.logging_config import configure_logging

configure_logging(get_settings().log_format, get_settings().log_level)
logger = logging.getLogger("tranding_track")

# Per-user webhook path template. The unguessable token in the URL is what
# authenticates the alert to a specific user's account.
WEBHOOK_PATH_TEMPLATE = "/api/webhook/tradingview/{token}"

broadcaster = Broadcaster()
_analyzer = MarketAnalyzer()


def _webhook_path(token: str) -> str:
    return WEBHOOK_PATH_TEMPLATE.format(token=token)


def _engine_for(db: Session, user: User):
    return get_manager().get(db, user)


def _analysis_for(engine, symbol: str, timeframe: str = "1h", limit: int = 200):
    """Fetch candles via a user's connector and run deterministic analysis."""
    try:
        raw = engine.connector.fetch_ohlcv(symbol.upper(), timeframe, min(limit, 1000))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OHLCV unavailable: {exc}")
    if not raw:
        raise HTTPException(status_code=502, detail="No candle data returned")
    df = pd.DataFrame(
        raw, columns=["timestamp", "open", "high", "low", "close", "volume"]
    )
    return _analyzer.analyze(df, symbol.upper())


def _bootstrap_admin(db: Session) -> None:
    """Ensure an admin exists: promote ADMIN_EMAIL, else the first user."""
    admin_email = (get_settings().admin_email or "").strip().lower()
    if admin_email:
        user = db.scalars(select(User).where(User.email == admin_email)).first()
        if user and user.role != UserRole.admin.value:
            user.role = UserRole.admin.value
            user.license_status = LicenseStatus.active.value
            db.commit()
            logger.info("Promoted %s to admin", admin_email)
    else:
        has_admin = db.scalars(
            select(User).where(User.role == UserRole.admin.value)
        ).first()
        if not has_admin:
            first = db.scalars(select(User).order_by(User.id.asc())).first()
            if first:
                first.role = UserRole.admin.value
                first.license_status = LicenseStatus.active.value
                db.commit()
                logger.info("Promoted first user %s to admin", first.email)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    loop = asyncio.get_running_loop()
    get_manager().attach_broadcaster(broadcaster, loop)
    from app.database import SessionLocal

    _db = SessionLocal()
    try:
        _bootstrap_admin(_db)
    finally:
        _db.close()
    if not get_settings().secret_key:
        logger.warning(
            "\u26a0\ufe0f SECRET_KEY is not set: login is disabled and per-user API "
            "keys cannot be stored. Set SECRET_KEY before going live."
        )
    monitor_task = asyncio.create_task(monitor_loop(get_manager(), broadcaster))
    logger.info("Tranding-track backend started (multi-user)")
    try:
        yield
    finally:
        monitor_task.cancel()
        try:
            await monitor_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Tranding-track", version=__version__, lifespan=lifespan)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- Health ---------------------------------------------------------


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "version": __version__}


# ---- Auth -----------------------------------------------------------


def _issue_token(user: User) -> str:
    s = get_settings()
    return create_access_token(
        s.secret_key,
        user_id=user.id,
        email=user.email,
        role=user.role,
        ttl_minutes=s.access_token_ttl_minutes,
    )


@app.post("/api/auth/signup", response_model=TokenResponse)
def signup(req: SignupRequest, db: Session = Depends(get_db)):
    s = get_settings()
    if not s.secret_key:
        raise HTTPException(
            status_code=503, detail="Signups are disabled (SECRET_KEY unset)."
        )
    email = req.email.strip().lower()
    if "@" not in email:
        raise HTTPException(status_code=400, detail="A valid email is required")
    if db.scalars(select(User).where(User.email == email)).first():
        raise HTTPException(status_code=409, detail="Email already registered")
    try:
        pw_hash = hash_password(req.password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    is_admin = bool(s.admin_email) and email == s.admin_email.strip().lower()
    first_user = db.scalars(select(User)).first() is None
    make_admin = is_admin or (not s.admin_email and first_user)
    licensed = make_admin or s.auto_license_new_users

    user = User(
        email=email,
        password_hash=pw_hash,
        role=UserRole.admin.value if make_admin else UserRole.user.value,
        license_status=(
            LicenseStatus.active.value if licensed else LicenseStatus.pending.value
        ),
        webhook_token=new_webhook_token(),
        binance_testnet=1,
    )
    from app.models import _utcnow  # local import to avoid cycle at top

    if licensed:
        user.licensed_at = _utcnow()
    db.add(user)
    db.commit()
    db.refresh(user)
    return TokenResponse(access_token=_issue_token(user))


@app.post("/api/auth/login", response_model=TokenResponse)
def login(req: LoginRequest, db: Session = Depends(get_db)):
    if not get_settings().secret_key:
        raise HTTPException(
            status_code=503, detail="Login is disabled (SECRET_KEY unset)."
        )
    email = req.email.strip().lower()
    user = db.scalars(select(User).where(User.email == email)).first()
    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return TokenResponse(access_token=_issue_token(user))


@app.get("/api/auth/me", response_model=MeOut)
def me(user: User = Depends(get_current_user)):
    return MeOut(
        id=user.id,
        email=user.email,
        role=user.role,
        license_status=user.license_status,
        webhook_path=_webhook_path(user.webhook_token),
        binance_keys_set=bool(user.binance_api_key_enc and user.binance_api_secret_enc),
        binance_testnet=bool(user.binance_testnet),
        ai_key_set=bool(user.ai_api_key_enc),
        ai_model=user.ai_model or "",
        secrets_storage_enabled=secrets_enabled(get_settings().secret_key),
    )


# ---- Per-user credentials (own trade-only keys) --------------------


@app.put("/api/credentials", response_model=MeOut)
def update_credentials(
    body: CredentialsUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_licensed_user),
):
    s = get_settings()
    if not secrets_enabled(s.secret_key):
        raise HTTPException(
            status_code=503,
            detail=(
                "Key storage is disabled because SECRET_KEY is not set. The "
                "operator must set SECRET_KEY before keys can be stored securely."
            ),
        )
    data = body.model_dump(exclude_unset=True)
    if "binance_api_key" in data and data["binance_api_key"] is not None:
        user.binance_api_key_enc = encrypt_secret(s.secret_key, data["binance_api_key"])
    if "binance_api_secret" in data and data["binance_api_secret"] is not None:
        user.binance_api_secret_enc = encrypt_secret(
            s.secret_key, data["binance_api_secret"]
        )
    if "binance_testnet" in data and data["binance_testnet"] is not None:
        user.binance_testnet = 1 if data["binance_testnet"] else 0
    if "ai_api_key" in data and data["ai_api_key"] is not None:
        user.ai_api_key_enc = (
            encrypt_secret(s.secret_key, data["ai_api_key"])
            if data["ai_api_key"]
            else None
        )
    if "ai_base_url" in data and data["ai_base_url"] is not None:
        user.ai_base_url = data["ai_base_url"]
    if "ai_model" in data and data["ai_model"] is not None:
        user.ai_model = data["ai_model"]
    if "ai_style" in data and data["ai_style"] is not None:
        user.ai_style = data["ai_style"]
    db.commit()
    db.refresh(user)
    # Rebuild the user's engine so new keys take effect immediately.
    get_manager().refresh(db, user)
    return me(user)


# ---- TradingView webhook (per-user token in the URL) ----------------


@app.post(WEBHOOK_PATH_TEMPLATE, response_model=ExecutionResult)
async def tradingview_webhook(
    token: str, request: Request, db: Session = Depends(get_db)
):
    """Execute a TradingView alert against the token-owner's account.

    The unguessable ``token`` in the URL identifies AND authenticates the target
    user, so alerts only ever touch that one account. The account must be
    licensed and running for the alert to act.
    """
    user = db.scalars(select(User).where(User.webhook_token == token)).first()
    if not user:
        raise HTTPException(status_code=404, detail="Unknown webhook token")
    raw = (await request.body()).decode("utf-8", errors="replace")
    try:
        data = json.loads(raw)
        signal = TradingViewSignal(**data)
    except Exception as exc:
        _log_signal(db, user.id, "tradingview", None, None, raw, False, f"parse error: {exc}")
        raise HTTPException(status_code=400, detail=f"Invalid signal payload: {exc}")

    if user.license_status != LicenseStatus.active.value:
        _log_signal(db, user.id, "tradingview", signal.symbol, signal.action, raw, False,
                    "account not licensed")
        raise HTTPException(status_code=403, detail="Account is not licensed")

    engine = _engine_for(db, user)
    accepted, message, trade = await asyncio.to_thread(
        engine.execute_signal,
        db,
        action=signal.action,
        symbol=signal.symbol,
        amount=signal.amount,
        stop_loss=signal.stop_loss,
        take_profit=signal.take_profit,
        source="tradingview",
        note=signal.note,
        limit_price=signal.limit_price,
    )
    _log_signal(db, user.id, "tradingview", signal.symbol, signal.action, raw, accepted, message)
    return ExecutionResult(
        accepted=accepted, message=message,
        trade=TradeOut.model_validate(trade) if trade else None,
    )


def _log_signal(db, user_id, source, symbol, action, raw, accepted, message) -> None:
    db.add(
        SignalLog(
            user_id=user_id, source=source, symbol=symbol, action=action, raw=raw,
            accepted=1 if accepted else 0, message=message,
        )
    )
    db.commit()


# ---- Manual orders -------------------------------------------------


@app.post("/api/order", response_model=ExecutionResult)
async def manual_order(
    order: ManualOrder,
    db: Session = Depends(get_db),
    user: User = Depends(require_licensed_user),
):
    engine = _engine_for(db, user)
    accepted, message, trade = await asyncio.to_thread(
        engine.execute_signal,
        db,
        action=order.action,
        symbol=order.symbol,
        amount=order.amount,
        stop_loss=order.stop_loss,
        take_profit=order.take_profit,
        source="manual",
        note="manual order",
        limit_price=order.limit_price,
    )
    return ExecutionResult(
        accepted=accepted, message=message,
        trade=TradeOut.model_validate(trade) if trade else None,
    )


@app.post("/api/trades/{trade_id}/close", response_model=ExecutionResult)
async def close_trade(
    trade_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_licensed_user),
):
    trade = db.get(Trade, trade_id)
    if (
        not trade
        or trade.user_id != user.id
        or trade.status not in (TradeStatus.open.value, TradeStatus.pending.value)
    ):
        raise HTTPException(status_code=404, detail="Open trade not found")
    engine = _engine_for(db, user)
    accepted, message, updated = await asyncio.to_thread(
        engine.execute_signal,
        db,
        action="close",
        symbol=trade.symbol,
        amount=None,
        stop_loss=None,
        take_profit=None,
        source="manual",
        note="manual close",
    )
    return ExecutionResult(
        accepted=accepted, message=message,
        trade=TradeOut.model_validate(updated) if updated else None,
    )


# ---- Trades & signals (scoped to the caller) ------------------------


@app.get("/api/trades", response_model=list[TradeOut])
def list_trades(
    status: str | None = None,
    limit: int = 100,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = select(Trade).where(Trade.user_id == user.id)
    if status:
        stmt = stmt.where(Trade.status == status)
    stmt = stmt.order_by(Trade.opened_at.desc()).limit(min(limit, 500))
    return list(db.scalars(stmt).all())


@app.get("/api/signals", response_model=list[SignalOut])
def list_signals(
    limit: int = 50,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = (
        select(SignalLog)
        .where(SignalLog.user_id == user.id)
        .order_by(SignalLog.created_at.desc())
        .limit(min(limit, 200))
    )
    return list(db.scalars(stmt).all())


# ---- Status & settings ---------------------------------------------


@app.get("/api/status", response_model=BotStatus)
def status(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _engine_for(db, user).status(db)


@app.get("/api/exchange/access")
def exchange_access(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """Report whether THIS user's key can read the account and place orders."""
    return _engine_for(db, user).connector.check_trading_access()


@app.post("/api/bot/{state}")
def set_bot_state(
    state: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_licensed_user),
):
    engine = _engine_for(db, user)
    if state == "start":
        engine.running = True
    elif state == "stop":
        engine.running = False
    else:
        raise HTTPException(status_code=400, detail="state must be 'start' or 'stop'")
    return {"running": engine.running}


def _settings_out(engine, user: User) -> SettingsOut:
    s = engine.settings
    return SettingsOut(
        trading_mode=s.trading_mode,
        binance_testnet=s.binance_testnet,
        max_open_positions=s.max_open_positions,
        risk_per_trade_pct=s.risk_per_trade_pct,
        daily_loss_limit_pct=s.daily_loss_limit_pct,
        default_stop_loss_pct=s.default_stop_loss_pct,
        default_take_profit_pct=s.default_take_profit_pct,
        trailing_stop_pct=s.trailing_stop_pct,
        max_total_exposure_pct=s.max_total_exposure_pct,
        min_signal_confidence=s.min_signal_confidence,
        auto_trade_enabled=s.auto_trade_enabled,
        auto_symbols=s.auto_symbols,
        auto_timeframe=s.auto_timeframe,
        auto_confirm_timeframe=s.auto_confirm_timeframe,
        ai_enabled=bool(s.ai_api_key),
        ai_model=s.ai_model,
        ai_style=engine.ai._style() if s.ai_api_key else "",
        notifications_enabled=engine.notifier.enabled,
        api_key_set=bool(user.binance_api_key_enc and user.binance_api_secret_enc),
        webhook_path=_webhook_path(user.webhook_token),
        webhook_secret_set=bool(user.webhook_token),
    )


@app.get("/api/settings", response_model=SettingsOut)
def get_settings_endpoint(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    return _settings_out(_engine_for(db, user), user)


@app.patch("/api/settings", response_model=SettingsOut)
def update_settings(
    update: SettingsUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_licensed_user),
):
    engine = _engine_for(db, user)
    s = engine.settings
    data = update.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(s, key, value)
    engine.apply_settings(s)
    engine.persist_settings(db, data)
    return _settings_out(engine, user)


# ---- Market data ----------------------------------------------------


@app.get("/api/ticker/{symbol:path}", response_model=TickerOut)
def ticker(
    symbol: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    engine = _engine_for(db, user)
    try:
        t = engine.connector.fetch_ticker(symbol.upper())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Ticker unavailable: {exc}")
    return TickerOut(
        symbol=symbol.upper(),
        last=float(t.get("last") or t.get("close") or 0),
        bid=t.get("bid"),
        ask=t.get("ask"),
        percentage=t.get("percentage"),
    )


@app.get("/api/ohlcv/{symbol:path}")
def ohlcv(
    symbol: str,
    timeframe: str = "1h",
    limit: int = 200,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    engine = _engine_for(db, user)
    try:
        raw = engine.connector.fetch_ohlcv(symbol.upper(), timeframe, min(limit, 1000))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OHLCV unavailable: {exc}")
    return [
        {"time": int(c[0] / 1000), "open": c[1], "high": c[2],
         "low": c[3], "close": c[4], "volume": c[5]}
        for c in raw
    ]


# ---- Backtesting ----------------------------------------------------


@app.get("/api/backtest")
def backtest(
    symbol: str,
    strategy: str = "ma_cross",
    timeframe: str = "1h",
    limit: int = 500,
    starting_balance: float = 10_000.0,
    fee_pct: float = 0.1,
    slippage_pct: float = 0.05,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    engine = _engine_for(db, user)
    try:
        raw = engine.connector.fetch_ohlcv(symbol.upper(), timeframe, min(limit, 1000))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OHLCV unavailable: {exc}")
    if not raw:
        raise HTTPException(status_code=502, detail="No candle data returned")
    df = pd.DataFrame(
        raw, columns=["timestamp", "open", "high", "low", "close", "volume"]
    )
    try:
        strat = build_strategy(strategy)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    result = run_backtest(
        df,
        strat,
        starting_balance=starting_balance,
        fee_pct=fee_pct,
        slippage_pct=slippage_pct,
    )
    return {
        "symbol": symbol.upper(),
        "strategy": strategy,
        "timeframe": timeframe,
        "starting_balance": result.starting_balance,
        "ending_balance": round(result.ending_balance, 2),
        "total_return_pct": round(result.total_return_pct, 2),
        "num_trades": result.num_trades,
        "win_rate_pct": round(result.win_rate_pct, 2),
        "max_drawdown_pct": round(result.max_drawdown_pct, 2),
        "total_fees": result.total_fees,
        "equity_curve": [round(e, 2) for e in result.equity_curve],
    }


# ---- Market analysis ("the brain") & AI ----------------------------


@app.get("/api/analyze/{symbol:path}")
def analyze(
    symbol: str,
    timeframe: str = "1h",
    explain: bool = False,
    assess: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    engine = _engine_for(db, user)
    analysis = _analysis_for(engine, symbol, timeframe)
    result = analysis.as_dict()
    if explain:
        result["narration"] = engine.ai.narrate(analysis)
        result["ai_enabled"] = engine.ai.available
    if assess:
        result["assessment"] = engine.ai.assess(analysis)
        result["ai_enabled"] = engine.ai.available
    return result


@app.post("/api/ai/ask")
def ai_ask(
    payload: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    question = str(payload.get("question", "")).strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")
    engine = _engine_for(db, user)
    symbol = payload.get("symbol")
    timeframe = payload.get("timeframe", "1h")
    analysis = _analysis_for(engine, symbol, timeframe) if symbol else None
    answer = engine.ai.ask(question, analysis)
    return {"answer": answer, "ai_enabled": engine.ai.available}


# ---- Strategies & training -----------------------------------------


@app.get("/api/strategies")
def strategies(user: User = Depends(get_current_user)):
    return [
        {"name": name, "params": PARAM_GRIDS.get(name, {})}
        for name in STRATEGY_REGISTRY
    ]


@app.post("/api/train")
def train_strategy(
    symbol: str,
    strategy: str = "ma_cross",
    timeframe: str = "1h",
    limit: int = 500,
    starting_balance: float = 10_000.0,
    fee_pct: float = 0.1,
    slippage_pct: float = 0.05,
    db: Session = Depends(get_db),
    user: User = Depends(require_licensed_user),
):
    engine = _engine_for(db, user)
    if strategy not in STRATEGY_REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown strategy '{strategy}'")
    try:
        raw = engine.connector.fetch_ohlcv(symbol.upper(), timeframe, min(limit, 1000))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OHLCV unavailable: {exc}")
    if not raw:
        raise HTTPException(status_code=502, detail="No candle data returned")
    df = pd.DataFrame(
        raw, columns=["timestamp", "open", "high", "low", "close", "volume"]
    )
    try:
        report = train(
            df, strategy, symbol=symbol.upper(), timeframe=timeframe,
            starting_balance=starting_balance, fee_pct=fee_pct,
            slippage_pct=slippage_pct,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {
        "symbol": report.symbol,
        "strategy": report.strategy,
        "timeframe": report.timeframe,
        "candles": report.candles,
        "tested": report.tested,
        "train_fraction": report.train_fraction,
        "warning": report.warning,
        "best": report.best.__dict__ if report.best else None,
        "leaderboard": [c.__dict__ for c in report.leaderboard],
    }


# ---- Admin: user & licence management ------------------------------


@app.get("/api/admin/users", response_model=list[UserOut])
def admin_list_users(
    db: Session = Depends(get_db), _admin: User = Depends(require_admin)
):
    return list(db.scalars(select(User).order_by(User.id.asc())).all())


@app.patch("/api/admin/users/{user_id}/license", response_model=UserOut)
def admin_set_license(
    user_id: int,
    body: LicenseUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target.id == admin.id and body.status != LicenseStatus.active.value:
        raise HTTPException(status_code=400, detail="Refusing to de-license yourself")
    from app.models import _utcnow

    target.license_status = body.status
    if body.status == LicenseStatus.active.value and target.licensed_at is None:
        target.licensed_at = _utcnow()
    db.commit()
    db.refresh(target)
    # Revoked/pending users must stop trading immediately: drop their engine.
    if body.status != LicenseStatus.active.value:
        get_manager().drop(target.id)
    return target


@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="Refusing to delete yourself")
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    get_manager().drop(target.id)
    db.delete(target)
    db.commit()
    return {"deleted": user_id}


# ---- WebSocket ------------------------------------------------------


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str | None = None):
    """Authenticated status stream. Pass the access token as ?token=... ."""
    from app.security import decode_access_token
    from app.database import SessionLocal

    secret = get_settings().secret_key
    payload = decode_access_token(secret, token or "")
    if not payload:
        await ws.close(code=4401)
        return
    try:
        user_id = int(payload.get("sub"))
    except (TypeError, ValueError):
        await ws.close(code=4401)
        return
    await broadcaster.connect(ws, user_id)
    try:
        db = SessionLocal()
        try:
            user = db.get(User, user_id)
            if user:
                await ws.send_json(
                    {"event": "status", "data": get_manager().get(db, user).status(db)}
                )
        finally:
            db.close()
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        await broadcaster.disconnect(ws)
    except Exception:
        await broadcaster.disconnect(ws)


# ---- Static frontend (single-service deploy, e.g. Railway) ----------
_STATIC_DIR = Path(os.getenv("STATIC_DIR", Path(__file__).resolve().parent.parent / "static"))
if _STATIC_DIR.is_dir() and (_STATIC_DIR / "index.html").is_file():
    app.mount(
        "/assets",
        StaticFiles(directory=str(_STATIC_DIR / "assets")),
        name="assets",
    )

    @app.get("/", include_in_schema=False)
    def _spa_root() -> FileResponse:
        return FileResponse(str(_STATIC_DIR / "index.html"))

    @app.get("/{full_path:path}", include_in_schema=False)
    def _spa_fallback(full_path: str) -> FileResponse:
        if full_path.startswith(("api/", "ws")):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = _STATIC_DIR / full_path
        if candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(_STATIC_DIR / "index.html"))

    logger.info("Serving dashboard from %s", _STATIC_DIR)
else:
    logger.info("No static dashboard at %s; running API-only", _STATIC_DIR)
