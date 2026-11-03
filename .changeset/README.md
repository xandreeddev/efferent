# Release notes

Run `bun run changeset` for a package change and commit the generated Markdown
file with the change. Choose a patch, minor, or major bump and describe the
resulting behavior. The 24 published framework packages form one fixed group;
changing one versions all of them together. Foundry and the website are not
released packages.

`bun run release:version` consumes pending notes through Changesets and prepares
the release PR: package and plugin versions, the central changelog, published
version markers, compatibility fixtures, generated documentation, and workspace
lock versions. It never publishes, tags, commits, or opens a pull request.

No pending release note means no version change. The prepared 0.16.0 release is
published at its existing version when this automation is introduced; do not
add a bump note merely to publish that version. Subsequent notes produce the
next shared version. Release fixtures are never overwritten.

Private source packages are included in versioning, and existing visibility
flags stay unchanged. Publishing uses Efferent's verified public build
artifacts rather than `changeset publish`.
