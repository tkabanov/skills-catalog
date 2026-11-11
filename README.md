# skills-catalog

My agent skills (Claude Code, Codex, …), one folder per skill in `skills/`.

| Skill | What it does |
|---|---|
| [record-test-video](skills/record-test-video/SKILL.md) | Records browser videos of test scenarios with captions and real checks, saved with scenarios, tests and a report in `~/test-videos/<project>/<task>/`. |

## Install

With [Herdr](https://github.com/tkabanov/herdr-setup), install the whole catalog as one skill group; the Skills panel then shows updates from this repo:

```sh
skills-update --add skills-catalog https://github.com/tkabanov/skills-catalog.git skills --title "Skills catalog"
```

The skills land in `~/.agents/skills/skills-catalog/<name>/`, and scripts refer to themselves by that path.
Without Herdr, copy or symlink `skills/<name>` to `~/.agents/skills/skills-catalog/<name>` and link it into your agent's skills folder.

Skills with a `package.json` install their dependencies on first run (`npm install` in the skill's folder).
