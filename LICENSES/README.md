# Candidate license packet

`AGPL-3.0-only.txt` is a byte-for-byte copy of the candidate root `LICENSE` and covers the candidate source under
`AGPL-3.0-only`. `RUNTIME-DEPENDENCIES.md` contains the reviewed MIT notices for all nine packages in the deployed
browser runtime closure. Their versions and npm integrity hashes are bound by `../RUNTIME-DEPENDENCY-LICENSES.json`.
Other lockfile entries are build/test-only tools and remain `NOASSERTION`; their code is not copied into `app/dist`.

Honest boundaries:

1. This packet is not legal advice.
2. It does not grant a commercial license or permission beyond the included license text.
3. A future runtime dependency change must update the frozen closure, integrity inventory, and included license text.
