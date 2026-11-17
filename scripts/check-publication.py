#!/usr/bin/env python3
"""固定规则检查公开候选文件，不打印疑似凭据本身，不替代完整审计"""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
# 不扫描已忽略的本地依赖，提交前仍需核对 git 暂存区
SKIP = {'.git', 'node_modules'}
FORBIDDEN_DIRS = {'services', 'sessions', 'private-audit', 'handoff', 'scratch'}
FORBIDDEN_FILES = {'session-config.json', 'turn.json', 'devices.json', 'shares.json'}
RULES = {
    'private-key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'),
    'github-token': re.compile(rb'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b'),
    'cloud-access-id': re.compile(rb'\bAKIA[A-Z0-9]{16}\b'),
    'credential-url': re.compile(rb'https?://[^\s/:<>]+:[^\s/@<>]+@'),
}
errors = []
count = 0
for file in ROOT.rglob('*'):
    rel = file.relative_to(ROOT)
    if any(part in SKIP for part in rel.parts):
        continue
    if file.is_symlink():
        errors.append((str(rel), 'symlink-review-required'))
        continue
    if not file.is_file():
        continue
    count += 1
    if any(part in FORBIDDEN_DIRS for part in rel.parts) or file.name in FORBIDDEN_FILES:
        errors.append((str(rel), 'private-runtime-file'))
    if file.name.startswith('.env') and file.name != '.env.example':
        errors.append((str(rel), 'environment-file'))
    if file.suffix.lower() in {'.pem', '.key', '.p12', '.pfx', '.bundle', '.har', '.pcap', '.pcapng', '.zip', '.jar', '.wasm'}:
        errors.append((str(rel), 'credential-or-unreviewed-artifact'))
    data = file.read_bytes()
    for name, pattern in RULES.items():
        if pattern.search(data):
            errors.append((str(rel), name))
for path, reason in errors:
    print(f'BLOCK {path}: {reason}')
print(f'Checked {count} files; {len(errors)} fixed-rule findings. Binary/source provenance still requires review.')
sys.exit(bool(errors))
