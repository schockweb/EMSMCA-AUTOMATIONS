"""
Provision (and remove) an isolated tenant for a load test against a LIVE system.

    python loadtest_provision.py --setup --crew 250
    python loadtest_provision.py --teardown --yes

WHY A DEDICATED PROVIDER
------------------------
A write load test creates real rows. Run it against an existing provider and
those rows are mixed in with that client's records for good — there is no marker
to find them by afterwards, and PRFs past DRAFT cannot be deleted through the
application at all.

Scoping the whole run to one throwaway provider makes the blast radius a single
tenant and the cleanup a single operation: everything the test created hangs off
this provider_id and goes with it. Tenant isolation is already enforced and
tested, so the load tenant cannot see or touch another client's data.

The slug is deliberately ugly and sorts last.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.database import engine
from app.models.crew_member import CrewMember
from app.models.service_provider import ServiceProvider
from app.utils.security import hash_password

SLUG = "zzz-loadtest-temporary"
NAME = "ZZZ LOADTEST — temporary, safe to delete"


async def setup(n_crew: int) -> None:
    S = async_sessionmaker(engine, expire_on_commit=False)
    async with S() as db:
        existing = (await db.execute(select(ServiceProvider).where(ServiceProvider.slug == SLUG))).scalar_one_or_none()
        if existing:
            print(f"  provider already exists: {existing.id}")
            prov = existing
        else:
            prov = ServiceProvider(
                name=NAME, slug=SLUG, prf_name="ZZLOAD",
                is_active=True,
                portal_login_email=f"{SLUG}@loadtest.invalid",
                portal_login_password_hash=hash_password(uuid.uuid4().hex),
            )
            db.add(prov)
            await db.flush()
            print(f"  created provider {prov.id}")

        have = (await db.execute(select(func.count()).select_from(CrewMember)
                                 .where(CrewMember.provider_id == prov.id))).scalar()
        for i in range(have, n_crew):
            db.add(CrewMember(
                provider_id=prov.id,
                email=f"loadcrew{i:04d}@{SLUG}.invalid",
                hashed_password=hash_password(uuid.uuid4().hex),
                full_name=f"Load Crew {i:04d}",
                qualification="AEA",
                # A registration number, because the PDF prints one and a crew
                # member without it renders "—" in the HPCSA row. The demo
                # records looked like the document was dropping the number when
                # in fact the test crew had never been given one. Format matches
                # a real HPCSA registration (category prefix + digits) so the
                # sheet reads the way a client's would.
                hpcsa_number=f"AEA{i:07d}",
                role="crew",
            ))
        await db.commit()
        total = (await db.execute(select(func.count()).select_from(CrewMember)
                                  .where(CrewMember.provider_id == prov.id))).scalar()
        print(f"  crew on this provider: {total}")
        print(f"  provider_id: {prov.id}")
    await engine.dispose()


async def teardown(yes: bool) -> None:
    S = async_sessionmaker(engine, expire_on_commit=False)
    async with S() as db:
        prov = (await db.execute(select(ServiceProvider).where(ServiceProvider.slug == SLUG))).scalar_one_or_none()
        if not prov:
            print("  nothing to remove — provider not present")
            await engine.dispose()
            return
        pid = str(prov.id)
        counts = {}
        for label, q in [
            ("digital_prfs", "select count(*) from digital_prfs where provider_id = cast(:p as uuid)"),
            ("crew_members", "select count(*) from crew_members where provider_id = cast(:p as uuid)"),
            ("cases", "select count(*) from cases where id in (select case_id from digital_prfs "
                      "where provider_id = cast(:p as uuid) and case_id is not null)"),
        ]:
            counts[label] = (await db.execute(text(q), {"p": pid})).scalar()
        print(f"  provider {pid}")
        for k, v in counts.items():
            print(f"    {k:14} {v}")
        if not yes:
            print("\n  re-run with --yes to delete\n")
            await engine.dispose()
            return

        # FK-safe order, and scoped to this provider throughout — nothing here
        # can reach another tenant's rows.
        stmts = [
            ("claim_lines", """delete from claim_lines where claim_id in (select id from claims where case_id in
                 (select case_id from digital_prfs where provider_id = cast(:p as uuid) and case_id is not null))"""),
            ("rfis", """delete from rfis where claim_id in (select id from claims where case_id in
                 (select case_id from digital_prfs where provider_id = cast(:p as uuid) and case_id is not null))"""),
            ("eras", """delete from eras where claim_id in (select id from claims where case_id in
                 (select case_id from digital_prfs where provider_id = cast(:p as uuid) and case_id is not null))"""),
            ("edi_submissions", """delete from edi_submissions where claim_id in (select id from claims where case_id in
                 (select case_id from digital_prfs where provider_id = cast(:p as uuid) and case_id is not null))"""),
            ("scheme_auth_requests", """delete from scheme_auth_requests where case_id in
                 (select case_id from digital_prfs where provider_id = cast(:p as uuid) and case_id is not null)"""),
            ("claims", """delete from claims where case_id in
                 (select case_id from digital_prfs where provider_id = cast(:p as uuid) and case_id is not null)"""),
            # ORDER MATTERS, and it was wrong here. `digital_prfs.document_id`
            # is an FK to `documents`, so deleting documents first fails with
            # digital_prfs_document_id_fkey the moment the tenant contains a
            # PROCESSED PRF. The load test never caught it because a pure
            # create-only run leaves every PRF a DRAFT with document_id NULL;
            # it surfaced the first time a campaign drove PRFs all the way
            # through the pipeline. Hold BOTH id sets first, then delete the
            # child (digital_prfs) before either parent.
            ("hold", """create temporary table _lt_ids as
                 select case_id, document_id from digital_prfs
                 where provider_id = cast(:p as uuid)"""),
            ("digital_prfs", "delete from digital_prfs where provider_id = cast(:p as uuid)"),
            ("documents", """delete from documents where id in
                 (select document_id from _lt_ids where document_id is not null)"""),
            ("cases", """delete from cases where id in
                 (select case_id from _lt_ids where case_id is not null)"""),
            # `audit_logs.crew_member_id` has an FK to crew_members, and that FK
            # is deliberate: it is what stops a real crew member being deleted
            # out from under the POPIA trail (see the deactivate-not-delete
            # design). It blocks this teardown as soon as the tenant's crew have
            # actually READ a record — an API-only load run never trips it, a
            # browser session does, because reading a PRF logs a PHI read.
            #
            # Removing these rows is not weakening that trail. They record a
            # synthetic crew member reading a synthetic patient inside a tenant
            # that is about to cease to exist, and the delete is scoped through
            # this provider's crew, so it cannot reach a real client's log.
            # The table is append-only at the DATABASE level, not just by
            # convention, and refuses DELETE unless the transaction opts in.
            # That guard is right and is left alone — this is the authorised
            # maintenance it describes, taken deliberately and one tenant wide.
            # SET LOCAL, so the opt-in dies with this transaction and cannot
            # leak into anything else on the connection.
            ("audit_maintenance", "set local ems.audit_maintenance = 'on'"),
            ("audit_logs", """delete from audit_logs where crew_member_id in
                 (select id from crew_members where provider_id = cast(:p as uuid))"""),
            ("crew_members", "delete from crew_members where provider_id = cast(:p as uuid)"),
            ("vehicles", "delete from vehicles where provider_id = cast(:p as uuid)"),
            ("service_provider", "delete from service_providers where id = cast(:p as uuid)"),
        ]
        for label, sql in stmts:
            res = await db.execute(text(sql), {"p": pid})
            print(f"    {label:20} {getattr(res, 'rowcount', 0)}")
        await db.commit()

    async with S() as db:
        left = (await db.execute(select(func.count()).select_from(ServiceProvider)
                                 .where(ServiceProvider.slug == SLUG))).scalar()
    print(f"\n  provider rows remaining: {left}  -> {'CLEAN' if left == 0 else 'INCOMPLETE'}\n")
    await engine.dispose()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--setup", action="store_true")
    ap.add_argument("--crew", type=int, default=250)
    ap.add_argument("--teardown", action="store_true")
    ap.add_argument("--yes", action="store_true")
    a = ap.parse_args()
    if a.teardown:
        asyncio.run(teardown(a.yes))
    elif a.setup:
        asyncio.run(setup(a.crew))
    else:
        ap.error("pass --setup or --teardown")


if __name__ == "__main__":
    main()
