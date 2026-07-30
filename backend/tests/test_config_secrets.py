"""
Production must refuse to boot on a placeholder secret.

SECRET_KEY and ENCRYPTION_KEY have no defaults, which reads as safe — but
.env.example ships both as the literal `CHANGE_ME`, so a deployer who copies the
example and fills in only the database URL gets a fully working instance:

  * jose signs tokens with any string, so every access token, refresh token and
    portal grant on that box is forgeable by anyone who has read our example
    file — including a token claiming SUPER_ADMIN.
  * app.utils.crypto deliberately DERIVES a valid Fernet key from any non-Fernet
    string so an odd prod key cannot brick the app. That resilience means a
    placeholder key encrypts and decrypts perfectly, with a key anyone can
    reproduce in one line.

This is the failure mode of handing the system to a client to install on their
own VM, so it has to fail loudly at startup.
"""
import pytest

from app.config import Settings

_GOOD_SECRET = "a-genuinely-long-random-secret-key-value-1234567890"
_GOOD_FERNET = "dGVzdC1vbmx5LWZlcm5ldC1rZXktZm9yLXVuaXQtdGU="


def _build(**overrides) -> Settings:
    """Construct Settings directly, bypassing the .env file.

    _env_file=None matters: without it pydantic-settings reads backend/.env and
    the real local secrets mask whatever the test is trying to assert.
    """
    kwargs = {
        "APP_ENV": "production",
        "SECRET_KEY": _GOOD_SECRET,
        "ENCRYPTION_KEY": _GOOD_FERNET,
        "_env_file": None,
    }
    kwargs.update(overrides)
    return Settings(**kwargs)


# ── Production refuses ──────────────────────────────────────────────────────

@pytest.mark.parametrize("placeholder", ["CHANGE_ME", "changeme", "change_me", "PLACEHOLDER", "TODO"])
def test_production_rejects_placeholder_secret_key(placeholder):
    with pytest.raises(ValueError) as exc:
        _build(SECRET_KEY=placeholder)
    assert "SECRET_KEY" in str(exc.value)


@pytest.mark.parametrize("placeholder", ["CHANGE_ME", "changeme", "PLACEHOLDER"])
def test_production_rejects_placeholder_encryption_key(placeholder):
    with pytest.raises(ValueError) as exc:
        _build(ENCRYPTION_KEY=placeholder)
    assert "ENCRYPTION_KEY" in str(exc.value)


def test_production_rejects_short_secret():
    """A 20-character key signs tokens perfectly well and is brute-forceable."""
    with pytest.raises(ValueError) as exc:
        _build(SECRET_KEY="short-but-not-empty!")
    assert "32" in str(exc.value)


def test_production_rejects_empty_secret():
    with pytest.raises(ValueError):
        _build(SECRET_KEY="   ")


def test_production_error_names_every_bad_field_at_once():
    """One restart should surface both problems, not one per attempt."""
    with pytest.raises(ValueError) as exc:
        _build(SECRET_KEY="CHANGE_ME", ENCRYPTION_KEY="CHANGE_ME")
    message = str(exc.value)
    assert "SECRET_KEY" in message and "ENCRYPTION_KEY" in message


# ── Real secrets are accepted ───────────────────────────────────────────────

def test_production_accepts_real_secrets():
    """The guard must not block a correctly configured production instance."""
    settings = _build()
    assert settings.SECRET_KEY == _GOOD_SECRET
    assert settings.ENCRYPTION_KEY == _GOOD_FERNET


def test_the_actual_env_example_placeholder_is_caught():
    """Pin the literal value .env.example ships, so a rename there is noticed."""
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[2]
    example = root / ".env.example"
    if not example.exists():
        pytest.skip(".env.example not present")

    shipped = {}
    for line in example.read_text(encoding="utf-8").splitlines():
        if line.startswith(("SECRET_KEY=", "ENCRYPTION_KEY=")):
            key, _, value = line.partition("=")
            shipped[key] = value.strip()

    assert shipped, ".env.example no longer defines SECRET_KEY / ENCRYPTION_KEY"
    for key, value in shipped.items():
        with pytest.raises(ValueError) as exc:
            _build(**{key: value})
        assert key in str(exc.value), (
            f".env.example ships {key}={value!r}, which production accepts. "
            f"Either it is a real secret (remove it) or the guard needs updating."
        )


# ── Development still boots ─────────────────────────────────────────────────

def test_development_only_warns():
    """Dev and CI must keep working with throwaway values."""
    with pytest.warns(UserWarning, match="INSECURE SECRETS"):
        settings = Settings(
            APP_ENV="development",
            SECRET_KEY="CHANGE_ME",
            ENCRYPTION_KEY="CHANGE_ME",
            _env_file=None,
        )
    assert settings.SECRET_KEY == "CHANGE_ME"


def test_test_env_only_warns():
    with pytest.warns(UserWarning, match="INSECURE SECRETS"):
        Settings(APP_ENV="test", SECRET_KEY="CHANGE_ME", ENCRYPTION_KEY="CHANGE_ME", _env_file=None)
