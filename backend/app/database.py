"""Database engine, session factory and Base declarative class."""
from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings

settings = get_settings()

# check_same_thread=False is required for SQLite when used across threads
# (FastAPI runs sync DB calls in a threadpool).
_connect_args = (
    {"check_same_thread": False}
    if settings.database_url.startswith("sqlite")
    else {}
)

engine = create_engine(settings.database_url, connect_args=_connect_args, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency that yields a database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create all tables and apply lightweight additive migrations.

    Import models so they register with Base, create any missing tables, then
    add columns that were introduced after a database was first created. This is
    a minimal migration path (additive only) so existing SQLite DBs keep working
    without a full Alembic setup.
    """
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _apply_additive_migrations()


# Columns added after initial release: {table: {column: SQL type + default}}.
_ADDED_COLUMNS: dict[str, dict[str, str]] = {
    "trades": {"stop_order_id": "VARCHAR(64)"},
}


def _apply_additive_migrations() -> None:
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    for table, columns in _ADDED_COLUMNS.items():
        if table not in existing_tables:
            continue
        present = {c["name"] for c in inspector.get_columns(table)}
        for column, ddl in columns.items():
            if column not in present:
                with engine.begin() as conn:
                    conn.execute(
                        text(f'ALTER TABLE {table} ADD COLUMN {column} {ddl}')
                    )
