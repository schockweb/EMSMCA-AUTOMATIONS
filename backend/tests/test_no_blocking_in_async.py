"""
No synchronous Celery publish may sit bare inside an async request handler.

`apply_async`/`delay` are kombu's SYNCHRONOUS publisher. Called bare inside
`async def` they block the uvicorn event loop, which stalls every request in
flight — not just the caller's. RabbitMQ's real failure mode under a memory or
disk alarm is to HANG rather than refuse, and a hung broker was measured at
4.09s of total event-loop freeze against an 8.4ms baseline. With 4 gunicorn
workers, roughly 4 concurrent submits is zero API throughput for everyone.

This is an AST check rather than a grep because a comment mentioning
`apply_async` should not fail it, and a genuine bare call should not be excused
by a nearby comment that happens to contain "to_thread".
"""
import ast
import pathlib

import pytest

API_DIR = pathlib.Path(__file__).resolve().parents[1] / "app" / "api"

PUBLISH_METHODS = {"delay", "apply_async"}


def _bare_publishes(tree: ast.AST) -> list[tuple[str, int]]:
    """Find `x.delay(...)` / `x.apply_async(...)` called directly in async defs.

    A publish handed to asyncio.to_thread / run_in_executor is passed as a bare
    ATTRIBUTE (a reference, not a call), so it never appears as ast.Call and is
    correctly ignored.
    """
    offenders: list[tuple[str, int]] = []

    class Visitor(ast.NodeVisitor):
        def __init__(self):
            self.async_depth = 0

        def visit_AsyncFunctionDef(self, node):
            self.async_depth += 1
            self.generic_visit(node)
            self.async_depth -= 1

        def visit_FunctionDef(self, node):
            # A nested plain `def` runs in a thread or as a task body — its
            # blocking calls do not touch the request's event loop.
            prev, self.async_depth = self.async_depth, 0
            self.generic_visit(node)
            self.async_depth = prev

        def visit_Call(self, node):
            if (
                self.async_depth > 0
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in PUBLISH_METHODS
            ):
                offenders.append((node.func.attr, node.lineno))
            self.generic_visit(node)

    Visitor().visit(tree)
    return offenders


@pytest.mark.parametrize(
    "path", sorted(API_DIR.glob("*.py")), ids=lambda p: p.name
)
def test_no_bare_celery_publish_in_async_handler(path):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    offenders = _bare_publishes(tree)
    assert not offenders, (
        f"{path.name} calls a synchronous Celery publish directly inside an "
        f"async handler at line(s) {[ln for _, ln in offenders]}. Wrap it: "
        f"await asyncio.to_thread(task.delay, ...) — a hung broker otherwise "
        f"freezes the event loop for every concurrent request."
    )


def test_the_check_actually_detects_a_bare_publish():
    """Guard the guard.

    Without this, a bug in the visitor would make every test above pass
    vacuously and the rule would silently stop being enforced.
    """
    bad = ast.parse(
        "async def submit():\n"
        "    process_prf_submission.delay('x')\n"
    )
    assert _bare_publishes(bad), "the AST check fails to detect a bare publish"

    good = ast.parse(
        "async def submit():\n"
        "    await asyncio.to_thread(process_prf_submission.delay, 'x')\n"
    )
    assert not _bare_publishes(good), "the AST check flags a correctly offloaded publish"

    in_sync_helper = ast.parse(
        "async def outer():\n"
        "    def _inner():\n"
        "        task.delay('x')\n"
        "    await asyncio.to_thread(_inner)\n"
    )
    assert not _bare_publishes(in_sync_helper), (
        "a publish inside a nested sync helper is not on the event loop"
    )
