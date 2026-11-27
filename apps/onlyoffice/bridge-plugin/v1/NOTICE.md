# Vendored plugin runtime (sdkjs-plugins/v1)

`plugins.js` and `plugins.css` are copied verbatim from
`ONLYOFFICE/onlyoffice.github.io` (`sdkjs-plugins/v1/`, master branch,
retrieved 2026-11-27). They are the sdkjs plugin loader shim that a plugin's
`index.html` includes; the actual `window.Asc` / `Asc.plugin` API is provided
by the editor itself (ONLYOFFICE and its Euro-Office fork both keep it).

License: GNU AGPL v3 (C) Ascensio System SIA 2010 — the copyright/license
headers in both files are preserved unmodified, per the license terms.

Vendoring them locally (instead of loading
`https://onlyoffice.github.io/sdkjs-plugins/v1/plugins.js` at runtime) keeps
the bridge plugin self-contained: no external network dependency, works
offline, and works identically inside Euro-Office, which is decoupling its
plugin ecosystem from ONLYOFFICE hosting (see Euro-Office/plugins#1).
