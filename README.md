# skills-catalog

My agent skills (Claude Code, Codex, …), one folder per skill in `skills/`.

| Skill | What it does |
|---|---|
| [record-test-video](skills/record-test-video/SKILL.md) | Records browser videos of test scenarios with captions and real checks, saved with scenarios, tests and a report in `~/test-videos/<project>/<task>/`. |

## Install a skill

Skills are installed by symlinking a folder from this repo into the agents' skills directory:

```sh
ln -s "$PWD/skills/<name>" ~/.agents/skills/<name>
ln -s ~/.agents/skills/<name> ~/.claude/skills/<name>
```

Skills with a `package.json` need their dependencies once:

```sh
(cd skills/<name> && npm ci)
```
