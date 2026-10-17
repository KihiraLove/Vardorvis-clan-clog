# Contributing

Use a branch and pull request. Describe the problem, resulting behavior and
the checks you ran. Keep changes focused and document new configuration.

Read the [architecture](docs/architecture.md) and relevant [API contracts](docs/contracts.md)
before changing business behavior. Run checks relevant to your change during
development; follow [AGENTS.md](AGENTS.md) for agent validation. The maintainer
runs complete acceptance before release. See [testing](docs/local-testing.md).

- Keep shared canonical item IDs stable. Approvals, corrections, revocations
  and receipts must stay transactional and audited.
- Add tests for new behavior and realistic failure cases. Use disposable databases.
- Keep secrets, private proof, database dumps and generated test output out of Git.
- Use local assets with recorded sources and licenses. Catalog changes need a
  reviewed provenance and coverage diff.
- This snapshot has one fresh-install baseline. After the first public release,
  add migrations instead of modifying SQL already shipped to users.
- For dependency changes, check supported Node 24, peer compatibility, the
  lockfile and relevant tests. Keep advisory results with release evidence.

Contributions to project code are under the [MIT license](LICENSE).
