#!/usr/bin/env python3
"""
End-to-end check of CompetitorPulse against the docker compose stack.

Uses only the Python standard library, curl-free. It runs on a compose project and host
ports of its own, so a development stack and its data are left alone, and it builds that
stack from scratch because the expected version sequences assume fresh listing-stub counters
and an empty database. It sets COMPOSE_POLL_INTERVAL_SECONDS=3600, so only the polls this
script forces happen: a scheduled poll arriving mid-scenario would add versions and consume
the mock's injected failures. The stack is removed afterwards.

    python3 scripts/e2e-smoke.py          # build a throwaway stack, run all scenarios, remove it
    python3 scripts/e2e-smoke.py --keep   # leave the stack up to look around

Scenarios:
  A  contract + LLM cost: 6 snapshots, 3 summaries, no LLM call for unchanged polls
  B  LLM fails: snapshot saved at once, summary 'failed' after 3 attempts, fields intact, requeue
  C  LLM slow (20 s): API and polling keep working, call aborted at the 15 s timeout
  D  restart: history intact, no catch-up burst, pending summaries still finish
  E  validation and removal: 409, 400, 204, 404, unknown source id
  F  operations: probes, metrics, migrations ran once as their own step
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

APP_PORT = os.environ.get('E2E_APP_PORT', '3100')
MOCK_PORT = os.environ.get('E2E_MOCK_LLM_PORT', '4101')
APP = f'http://localhost:{APP_PORT}'
MOCK = f'http://localhost:{MOCK_PORT}'

COMPOSE_ENV = {
    **os.environ,
    'COMPOSE_PROJECT_NAME': 'competitor-pulse-e2e',
    'COMPOSE_POLL_INTERVAL_SECONDS': '3600',
    'COMPOSE_LLM_MAX_ATTEMPTS': '3',
    'APP_PORT': APP_PORT,
    'MOCK_LLM_PORT': MOCK_PORT,
    'STUB_PORT': os.environ.get('E2E_STUB_PORT', '4102'),
    'DB_PORT': os.environ.get('E2E_DB_PORT', '5533'),
}


def compose(*args):
    return subprocess.run(['docker', 'compose', *args], cwd=ROOT, env=COMPOSE_ENV, check=True,
                          capture_output=True, text=True)

results = []


# ---- helpers ------------------------------------------------------------------------

def http(method, url, body=None, timeout=10):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header('content-type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
            return res.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as err:
        raw = err.read()
        return err.code, json.loads(raw) if raw else None


def snapshot(cid, snapshot_id):
    return next(s for s in snapshots(cid) if s['id'] == snapshot_id)


def snapshots(cid):
    status, body = http('GET', f'{APP}/api/competitors/{cid}/snapshots')
    assert status == 200, f'GET snapshots {cid} -> {status} {body}'
    return body


def oldest_first(cid):
    return list(reversed(snapshots(cid)))


def add(cid):
    return http('POST', f'{APP}/api/competitors', {'id': cid})[0]


def poll(cid):
    """Forces a poll and waits until it has produced one more snapshot."""
    before = len(snapshots(cid))
    status, _ = http('POST', f'{APP}/api/competitors/{cid}/poll')
    assert status == 202, f'poll {cid} -> {status}'
    wait_until(f'{cid} has {before + 1} snapshots', lambda: len(snapshots(cid)) > before, 10)


def mock_calls():
    return http('GET', f'{MOCK}/control/stats')[1]['callCount']


def mock(path, body=None):
    http('POST', f'{MOCK}/control/{path}', body or {})


def psql(query):
    out = compose('exec', '-T', 'db', 'psql', '-U', 'competitorpulse', '-d', 'competitorpulse', '-tAc', query)
    return out.stdout.strip()


def wait_until(label, predicate, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.5)
    raise AssertionError(f'timed out after {timeout}s waiting for: {label}')


def check(name, ok, detail=''):
    results.append((name, ok))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{f' — {detail}' if detail else ''}", flush=True)


def scenario(title):
    def wrap(fn):
        def run():
            print(f'\n{title}', flush=True)
            try:
                fn()
            except AssertionError as err:
                check('scenario completed', False, str(err))
        return run
    return wrap


def wait_app_healthy(timeout=120):
    def healthy():
        try:
            return http('GET', f'{APP}/health', timeout=2)[0] == 200
        except OSError:
            return False
    wait_until('app /health', healthy, timeout)


# ---- scenarios ----------------------------------------------------------------------

@scenario('A. Contract and LLM cost (acme-crm)')
def scenario_a():
    mock('reset')
    status = add('acme-crm')
    check('POST /api/competitors -> 201', status == 201, str(status))
    status, body = http('GET', f'{APP}/api/competitors')
    check('GET /api/competitors lists it', status == 200 and any(c['id'] == 'acme-crm' for c in body))

    wait_until('first snapshot', lambda: len(snapshots('acme-crm')) == 1, 10)
    for _ in range(5):
        poll('acme-crm')
    wait_until('no pending summaries', lambda: all(s['summaryStatus'] != 'pending' for s in snapshots('acme-crm')), 20)

    newest_first = snapshots('acme-crm')
    times = [s['fetchedAt'] for s in newest_first]
    check('6 snapshots, newest first', len(newest_first) == 6 and times == sorted(times, reverse=True), str(len(times)))
    check('fetchedAt is ISO 8601 UTC', all(t.endswith('Z') and 'T' in t for t in times))
    rows = list(reversed(newest_first))
    changed = [s['changed'] for s in rows]
    check('changed = F,T,T,T,F,F', changed == [False, True, True, True, False, False], str(changed))
    has_summary = [isinstance(s['summary'], str) and len(s['summary']) > 0 for s in rows]
    check('summary on the 3 changed snapshots only', has_summary == changed, str(has_summary))
    contract = {'fetchedAt', 'title', 'tagline', 'price', 'description', 'changed', 'summary'}
    check('every snapshot has the contract fields', all(contract <= set(s) for s in rows))

    check('mock callCount = 3', mock_calls() == 3, str(mock_calls()))
    poll('acme-crm')
    poll('acme-crm')
    time.sleep(2)
    check('2 more unchanged polls: callCount still 3 (no paid call)', mock_calls() == 3, str(mock_calls()))


@scenario('B. The LLM fails (ferry-pay)')
def scenario_b():
    mock('reset')
    mock('configure', {'failNext': 3})
    add('ferry-pay')
    wait_until('first snapshot', lambda: len(snapshots('ferry-pay')) == 1, 10)
    poll('ferry-pay')

    latest = snapshots('ferry-pay')[0]
    check('changed snapshot is stored immediately',
          latest['changed'] and latest['price'] == '2.5% + $0.30 per transaction' and latest['summary'] is None,
          f"{latest['summaryStatus']} {latest['price']}")

    wait_until('summary failed', lambda: snapshot('ferry-pay', latest['id'])['summaryStatus'] == 'failed', 45)
    failed = snapshot('ferry-pay', latest['id'])
    same = all(failed[k] == latest[k] for k in ('fetchedAt', 'title', 'tagline', 'price', 'description', 'changed'))
    check("after 3 failures: summaryStatus 'failed', summary null", failed['summary'] is None)
    check('listing fields unchanged by the failures', same)
    check('app still healthy', http('GET', f'{APP}/health')[0] == 200)
    attempts = psql(f"select summary_attempts from snapshots where id = {failed['id']}")
    check('exactly 3 attempts were made', attempts == '3', attempts)

    poll('ferry-pay')
    next_change = snapshots('ferry-pay')[0]
    assert next_change['changed'], 'expected version 3 to be a change'
    wait_until('next change summarised',
               lambda: snapshot('ferry-pay', next_change['id'])['summaryStatus'] == 'ready', 15)
    check('failures are per snapshot: the next change gets a summary', True)

    status, body = http('POST', f'{APP}/api/summaries/retry-failed')
    check('retry-failed requeues the failed summary', status == 200 and body['requeued'] == 1, str(body))
    wait_until('requeued summary finishes', lambda: snapshot('ferry-pay', failed['id'])['summaryStatus'] == 'ready', 15)
    check('the requeued summary is produced after the outage', True)


@scenario('C. The LLM is slow (north-analytics)')
def scenario_c():
    mock('reset')
    mock('configure', {'latencyMs': 20000})
    add('north-analytics')
    wait_until('first snapshot', lambda: len(snapshots('north-analytics')) == 1, 10)
    poll('north-analytics')
    slow_id = snapshots('north-analytics')[0]['id']
    time.sleep(2)  # the summary call is now hanging

    started = time.time()
    http('GET', f'{APP}/api/competitors')
    elapsed = time.time() - started
    check('API answers while the LLM hangs', elapsed < 1, f'{elapsed:.3f}s')

    started = time.time()
    poll('acme-crm')
    check('polling continues while the LLM hangs', time.time() - started < 5, f'{time.time() - started:.1f}s')

    wait_until('timeout recorded',
               lambda: 'timed out' in psql(f'select coalesce(summary_error, \'\') from snapshots where id = {slow_id}'), 25)
    error = psql(f'select summary_error from snapshots where id = {slow_id}')
    check('call aborted at the 15 s timeout, not after 20 s', 'timed out after 15000 ms' in error, error)

    mock('reset')
    wait_until('retry succeeds', lambda: snapshot('north-analytics', slow_id)['summaryStatus'] == 'ready', 30)
    check('retry after the timeout produces the summary', True)


@scenario('D. Restart')
def scenario_d():
    mock('reset')
    mock('configure', {'latencyMs': 4000})
    poll('north-analytics')  # version 3: a change whose summary is in flight during the restart
    in_flight = snapshots('north-analytics')[0]
    assert in_flight['changed'], 'expected version 3 to be a change'
    pending_id = in_flight['id']
    counts = {c: len(snapshots(c)) for c in ('acme-crm', 'ferry-pay', 'north-analytics')}
    time.sleep(2)  # the worker claims within 1 s; the 4 s LLM call is now in flight

    compose('restart', 'app')
    wait_app_healthy()
    after = {c: len(snapshots(c)) for c in counts}
    check('history intact after restart', all(after[c] >= counts[c] for c in counts), f'{counts} -> {after}')
    time.sleep(5)
    after5 = {c: len(snapshots(c)) for c in counts}
    check('no catch-up burst (at most 1 new snapshot each)', all(after5[c] - counts[c] <= 1 for c in counts),
          f'{counts} -> {after5}')

    mock('reset')
    wait_until('in-flight summary finishes after restart',
               lambda: psql(f'select summary_status from snapshots where id = {pending_id}') == 'ready', 60)
    check('summary pending at restart still completes', True)
    logs = compose('logs', 'app').stdout.splitlines()
    check('the in-flight LLM call was interrupted and released, not lost',
          any(f'"snapshotId":{pending_id},' in line and 'interrupted by shutdown' in line for line in logs))


@scenario('E. Validation and removal')
def scenario_e():
    check('duplicate id -> 409', add('acme-crm') == 409)
    check('invalid id -> 400', add('Bad Id!') == 400)
    check('DELETE -> 204', http('DELETE', f'{APP}/api/competitors/acme-crm')[0] == 204)
    check('DELETE again -> 404', http('DELETE', f'{APP}/api/competitors/acme-crm')[0] == 404)
    check('snapshots of a removed competitor -> 404',
          http('GET', f'{APP}/api/competitors/acme-crm/snapshots')[0] == 404)

    check('id unknown to the source is accepted -> 201', add('does-not-exist') == 201)

    def poll_error():
        competitors = http('GET', f'{APP}/api/competitors')[1]
        return next((c['lastPollError'] for c in competitors if c['id'] == 'does-not-exist'), None)
    wait_until('poll error recorded', lambda: poll_error() is not None, 10)
    check('its poll error is shown in the list', 'does not know' in poll_error(), poll_error())
    check('and it has no snapshots', snapshots('does-not-exist') == [])


@scenario('F. Operations')
def scenario_f():
    check('GET /livez -> 200', http('GET', f'{APP}/livez')[0] == 200)
    check('GET /readyz -> 200', http('GET', f'{APP}/readyz')[0] == 200)
    with urllib.request.urlopen(f'{APP}/metrics', timeout=5) as res:
        metrics = res.read().decode()
    for line in ('competitorpulse_summaries{status="pending"}', 'competitorpulse_poll_lag_seconds',
                 'competitorpulse_loop_tick_age_seconds{loop="summary"}', 'competitorpulse_polls_total{outcome="error"}'):
        check(f'/metrics has {line}', line in metrics)
    status, body = http('GET', f'{APP}/openapi.json')
    check('/openapi.json describes the API', status == 200 and '/api/competitors' in body['paths'])
    check('migrations ran as their own step', 'migrations applied' in compose('logs', 'migrate').stdout)
    stub_absent = compose('run', '--rm', '--no-deps', '-T', 'migrate', 'sh', '-c',
                          'test ! -e server/dist/stub && test ! -e server/fixtures && echo absent').stdout
    check('the stub and fixtures are not in the app image', 'absent' in stub_absent, stub_absent.strip())


# ---- main ---------------------------------------------------------------------------

def main():
    print(f"Building a throwaway stack: compose project {COMPOSE_ENV['COMPOSE_PROJECT_NAME']}, app on {APP}", flush=True)
    compose('down', '-v')
    compose('up', '--build', '-d', '--wait')
    wait_app_healthy()

    started = time.time()
    try:
        for run in (scenario_a, scenario_b, scenario_c, scenario_d, scenario_e, scenario_f):
            run()
    finally:
        if '--keep' not in sys.argv:
            compose('down', '-v')
    failed = [name for name, ok in results if not ok]
    print(f'\n{len(results) - len(failed)}/{len(results)} checks passed in {time.time() - started:.0f}s')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
