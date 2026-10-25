#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Run the three explicit provider SFTP tests against a disposable loopback OpenSSH server.
Requires TEST_DATABASE_URL, OpenSSH sftp/sshd/ssh-keygen, and the local OS account's
public-key authentication support. Never uses a provider account or real credentials.
"""
import argparse
import getpass
import os
import pathlib
import shutil
import socket
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--toolchain', help='Optional installed Rust toolchain, e.g. 1.99.1')
    args = parser.parse_args()
    if not os.environ.get('TEST_DATABASE_URL'):
        parser.exit(1, 'Set TEST_DATABASE_URL to a disposable local PostgreSQL database.\n')
    sshd = shutil.which('sshd') or '/usr/sbin/sshd'
    subsystem = next((p for p in ('/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/ssh/sftp-server') if pathlib.Path(p).is_file()), None)
    if not pathlib.Path(sshd).is_file() or not subsystem or not pathlib.Path('/usr/bin/sftp').is_file() or not shutil.which('ssh-keygen'):
        parser.exit(1, 'OpenSSH server, client, subsystem and key generator are required.\n')
    with socket.socket() as check:
        check.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            check.bind(('127.0.0.1', 8098))
        except OSError:
            parser.exit(1, 'Loopback port 8098 is occupied; stop the prior synthetic fixture first.\n')
    with tempfile.TemporaryDirectory(prefix='suncharts-provider-sftp-') as temp:
        root = pathlib.Path(temp)
        root.chmod(0o700)
        for name in ('host', 'client', 'wrong-host'):
            subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(root / name)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (root / 'known_hosts').write_text('[127.0.0.1]:8098 ' + (root / 'host.pub').read_text())
        (root / 'bad_known_hosts').write_text('[127.0.0.1]:8098 ' + (root / 'wrong-host.pub').read_text())
        config = root / 'sshd_config'
        config.write_text(f'Port 8098\nListenAddress 127.0.0.1\nHostKey {root}/host\nPidFile {root}/sshd.pid\nAuthorizedKeysFile {root}/client.pub\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM no\nStrictModes yes\nAllowUsers {getpass.getuser()}\nSubsystem sftp {subsystem}\n')
        subprocess.run([sshd, '-t', '-f', str(config)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        server = subprocess.Popen([sshd, '-D', '-e', '-f', str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(50):
                if server.poll() is not None:
                    parser.exit(1, 'Synthetic OpenSSH server failed to start.\n')
                try:
                    with socket.create_connection(('127.0.0.1', 8098), timeout=0.1):
                        break
                except OSError:
                    time.sleep(0.1)
            else:
                parser.exit(1, 'Synthetic OpenSSH server did not become ready.\n')
            env = dict(os.environ, SUNCHARTS_SFTP_FIXTURE=str(root), ENGINE_CLEARINGHOUSE_SFTP_TEST_USER=getpass.getuser(), ENGINE_CLEARINGHOUSE_SFTP_TEST_KEY=str(root / 'client'), ENGINE_CLEARINGHOUSE_SFTP_TEST_HOSTS=str(root / 'known_hosts'), ENGINE_CLEARINGHOUSE_SFTP_TEST_BAD_HOSTS=str(root / 'bad_known_hosts'))
            command = ['cargo'] + (['+' + args.toolchain] if args.toolchain else []) + ['test', '--test', 'connect_migrate', 'sftp_', '--', '--ignored']
            result = subprocess.run(command, env=env, cwd=pathlib.Path(__file__).resolve().parent.parent)
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
        return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
