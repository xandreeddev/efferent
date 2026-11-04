---
"@xandreed/plugin-tool-discovery": patch
"@xandreed/plugin-workspace": patch
"@xandreed/core": patch
---

Tool discovery's catalogue section lists the references of always-on skills, which no `load_skill` result shows, so the model can read them with `read_skill_reference`; the skills directory's always-on section no longer repeats them.
