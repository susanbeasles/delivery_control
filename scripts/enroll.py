#!/usr/bin/env python3
"""Preview or enroll every active personal main-branch repository via signed PRs."""
import argparse
import getpass
import json
from pathlib import Path
import subprocess
import tempfile

OWNER = 'susanbeasles'

def run(args, *, cwd=None, data=None):
    return subprocess.run(args, cwd=cwd, input=data, text=True, check=True, capture_output=True).stdout

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Set scoped dispatch secrets and open signed enrollment PRs')
    args = parser.parse_args()
    me = json.loads(run(['gh', 'api', 'user']))
    if me['login'] != OWNER or me['id'] != 215839550:
        raise RuntimeError('Authenticate gh as susanbeasles before enrollment')
    pages = json.loads(run(['gh', 'api', '--paginate', '--slurp', 'user/repos?per_page=100&affiliation=owner&visibility=all']))
    repos = sorted((r for page in pages for r in page if r['owner']['id'] == 215839550 and not r['archived'] and not r['fork'] and r['default_branch'] == 'main'), key=lambda r: r['full_name'])
    for repo in repos:
        print(repo['full_name'])
    if not args.apply:
        print(f'Preview: {len(repos)} repositories; rerun with --apply to enroll.')
        return
    run(['gh', 'api', f'repos/{OWNER}/delivery_control/contents/.github/workflows/release.yml?ref=main'])
    token = getpass.getpass('Dispatch credential (Actions: write on delivery_control only): ')
    if not token:
        raise RuntimeError('Empty dispatch credential')
    template = (Path(__file__).resolve().parent.parent / 'templates/auto-release.yml').read_text()
    for repo in repos:
        name = repo['full_name']
        print(f'Enrolling {name}', flush=True)
        run(['gh', 'secret', 'set', 'RELEASE_DISPATCH_TOKEN', '--repo', name], data=token)
        with tempfile.TemporaryDirectory(prefix='release-enroll-') as directory:
            checkout = Path(directory) / 'repository'
            run(['gh', 'repo', 'clone', name, str(checkout), '--', '--depth=1', '--branch=main'])
            target = checkout / '.github/workflows/auto-release.yml'
            if target.exists() and target.read_text() == template:
                print('Caller already installed; secret refreshed.')
                continue
            if target.exists():
                raise RuntimeError(f'{name} has an existing auto-release.yml; review it before replacing')
            branch = 'codex/release-on-main'
            existing = run(['git', 'ls-remote', '--heads', 'origin', f'refs/heads/{branch}'], cwd=checkout)
            if existing.strip():
                raise RuntimeError(f'{name} already has {branch}; review its pending enrollment PR')
            run(['git', 'switch', '-c', branch], cwd=checkout)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(template)
            run(['git', 'add', '.github/workflows/auto-release.yml'], cwd=checkout)
            run(['git', 'commit', '-S', '-m', 'ci: dispatch official releases on main pushes'], cwd=checkout)
            run(['git', 'push', '-u', 'origin', branch], cwd=checkout)
            url = run(['gh', 'pr', 'create', '--repo', name, '--base', 'main', '--head', branch,
                '--title', 'ci: dispatch official releases on main pushes',
                '--body', 'Every main push requests a source release from delivery_control. The caller forwards the exact push SHA and source run identity using a central Actions-only dispatch credential. The release App key remains confined to delivery_control.'], cwd=checkout)
            print(url.strip())
    print('Enrollment PRs created. Land them through each repository\'s existing promotion policy.')

if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        # Avoid emitting command output that could include credentials.
        raise SystemExit(f'Enrollment command failed (exit {error.returncode}); reconcile the last repository before retrying.')
    except Exception as error:
        raise SystemExit(str(error))
