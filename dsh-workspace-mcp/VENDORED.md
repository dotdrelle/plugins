# Vendored build of dsh-workspace-mcp

Compiled copy of [Momojie-S/dsh-workspace-mcp](https://github.com/Momojie-S/dsh-workspace-mcp)
at commit `4e9c8d816c366ac92fc04a6fe0023f6a306da599` (version 0.3.0, MIT, see `LICENSE`).

The upstream repository holds only TypeScript sources, so installing it runs a
build that needs `allowBuilds` and `npm`. This copy ships `lib/` and has no
`prepare` script, so it installs on a machine with neither. In Harness Desktop:

    git+https://github.com/dotdrelle/plugins.git#main&path:/dsh-workspace-mcp

It does not follow upstream. To update it, rebuild upstream and replace `lib/`
and the commit above.
