from sqlalchemy import create_engine, event
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from .config import settings

is_sqlite = settings.DATABASE_URL.startswith("sqlite")
is_mysql = "mysql" in settings.DATABASE_URL

engine_kwargs: dict = {"pool_pre_ping": True}
if is_sqlite:
    engine_kwargs["connect_args"] = {"check_same_thread": False, "timeout": 15}
elif is_mysql:
    engine_kwargs["connect_args"] = {"charset": "utf8mb4"}
    engine_kwargs["pool_size"] = 10
    engine_kwargs["max_overflow"] = 20
else:
    engine_kwargs["pool_size"] = 10
    engine_kwargs["max_overflow"] = 20

engine = create_engine(settings.DATABASE_URL, **engine_kwargs)

if is_sqlite:

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=15000")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _sqlite_add_missing_visit_columns():
    """Older SQLite DBs may lack columns added later; create_all does not ALTER tables."""
    from sqlalchemy import inspect, text

    if not settings.DATABASE_URL.startswith("sqlite"):
        return
    try:
        insp = inspect(engine)
        col_names = {c["name"] for c in insp.get_columns("visits")}
    except Exception:
        return
    with engine.begin() as conn:
        if "customer_signature" not in col_names:
            conn.execute(text("ALTER TABLE visits ADD COLUMN customer_signature TEXT"))
        if "signature_captured_at" not in col_names:
            conn.execute(text("ALTER TABLE visits ADD COLUMN signature_captured_at DATETIME"))
        if "anpr_camera_seconds" not in col_names:
            conn.execute(text("ALTER TABLE visits ADD COLUMN anpr_camera_seconds REAL"))
        if "supervisor_signature" not in col_names:
            conn.execute(text("ALTER TABLE visits ADD COLUMN supervisor_signature TEXT"))
        if "supervisor_signed_by" not in col_names:
            conn.execute(text("ALTER TABLE visits ADD COLUMN supervisor_signed_by INTEGER"))


def _sqlite_add_missing_anpr_columns():
    from sqlalchemy import inspect, text

    if not settings.DATABASE_URL.startswith("sqlite"):
        return
    try:
        insp = inspect(engine)
        if "anpr_detections" not in insp.get_table_names():
            return
        col_names = {c["name"] for c in insp.get_columns("anpr_detections")}
    except Exception:
        return
    with engine.begin() as conn:
        if "t_enter_sec" not in col_names:
            conn.execute(text("ALTER TABLE anpr_detections ADD COLUMN t_enter_sec REAL"))
        if "t_exit_sec" not in col_names:
            conn.execute(text("ALTER TABLE anpr_detections ADD COLUMN t_exit_sec REAL"))
        if "duration_sec" not in col_names:
            conn.execute(text("ALTER TABLE anpr_detections ADD COLUMN duration_sec REAL"))


def _sqlite_add_missing_audit_columns():
    from sqlalchemy import inspect, text

    if not settings.DATABASE_URL.startswith("sqlite"):
        return
    try:
        insp = inspect(engine)
        if "audit_logs" not in insp.get_table_names():
            return
        acols = {c["name"] for c in insp.get_columns("audit_logs")}
    except Exception:
        return
    if "description" not in acols:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE audit_logs ADD COLUMN description TEXT"))


def _ensure_audit_description_column_mysql_pg():
    """Add audit_logs.description when upgrading existing MySQL/Postgres DBs."""
    from sqlalchemy import inspect, text

    if settings.DATABASE_URL.startswith("sqlite"):
        return
    try:
        insp = inspect(engine)
        if "audit_logs" not in insp.get_table_names():
            return
        acols = {c["name"] for c in insp.get_columns("audit_logs")}
        if "description" in acols:
            return
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE audit_logs ADD COLUMN description TEXT"))
    except Exception:
        pass


def _ensure_visit_anpr_and_detection_timing_columns():
    """MySQL/Postgres: add columns introduced after first deploy."""
    from sqlalchemy import inspect, text

    if settings.DATABASE_URL.startswith("sqlite"):
        return
    try:
        insp = inspect(engine)
        tables = set(insp.get_table_names())
        if "visits" in tables:
            vcols = {c["name"] for c in insp.get_columns("visits")}
            if "anpr_camera_seconds" not in vcols:
                with engine.begin() as conn:
                    conn.execute(text("ALTER TABLE visits ADD COLUMN anpr_camera_seconds DOUBLE"))
            if "supervisor_signature" not in vcols:
                with engine.begin() as conn:
                    conn.execute(text("ALTER TABLE visits ADD COLUMN supervisor_signature TEXT"))
            if "supervisor_signed_by" not in vcols:
                with engine.begin() as conn:
                    conn.execute(text("ALTER TABLE visits ADD COLUMN supervisor_signed_by INTEGER"))
        if "anpr_detections" in tables:
            acols = {c["name"] for c in insp.get_columns("anpr_detections")}
            with engine.begin() as conn:
                if "t_enter_sec" not in acols:
                    conn.execute(text("ALTER TABLE anpr_detections ADD COLUMN t_enter_sec DOUBLE"))
                if "t_exit_sec" not in acols:
                    conn.execute(text("ALTER TABLE anpr_detections ADD COLUMN t_exit_sec DOUBLE"))
                if "duration_sec" not in acols:
                    conn.execute(text("ALTER TABLE anpr_detections ADD COLUMN duration_sec DOUBLE"))
    except Exception:
        pass


def init_db():
    from .models import vehicle, visit, service, user, audit, anpr, application_error  # noqa
    Base.metadata.create_all(bind=engine)
    _sqlite_add_missing_visit_columns()
    _sqlite_add_missing_anpr_columns()
    _sqlite_add_missing_audit_columns()
    _ensure_audit_description_column_mysql_pg()
    _ensure_visit_anpr_and_detection_timing_columns()
