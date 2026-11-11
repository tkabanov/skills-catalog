# skills-catalog

My agent skills (Claude Code, Codex, …), one folder per skill in `skills/`.

| Skill | What it does |
|---|---|
| [record-test-video](skills/record-test-video/SKILL.md) | Records browser videos of test scenarios with captions and real checks, saved with scenarios, tests and a report in `~/test-videos/<project>/<task>/`. |

## Install

Install the catalog into the shared agent skills folder, one folder per skill:

```sh
git clone https://github.com/tkabanov/skills-catalog.git /tmp/skills-catalog
mkdir -p ~/.agents/skills/skills-catalog
cp -R /tmp/skills-catalog/skills/* ~/.agents/skills/skills-catalog/
```

Then link the skills your agent should see into its skills folder, e.g. for Claude Code:

```sh
ln -s ~/.agents/skills/skills-catalog/<name> ~/.claude/skills/<name>
```

Scripts refer to themselves by the path `~/.agents/skills/skills-catalog/<name>/`.
Skills with a `package.json` install their dependencies on first run (`npm install` in the skill's folder).
