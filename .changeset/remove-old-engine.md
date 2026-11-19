---
"@xandreed/core": minor
"@xandreed/sdk": minor
---

The engine of earlier releases is gone, and the kernel is the way to build an agent (ADR 0036): `@xandreed/runtime`, `@xandreed/process-host` and the `@xandreed/plugin-*` packages are no longer published (they stay on npm at 0.22.0), and of `@xandreed/core` and `@xandreed/sdk` only the kernels are left. Each package's root entry now names its kernel's index, the same module as `./kernel`. The changelog lists what replaces each removed package.
