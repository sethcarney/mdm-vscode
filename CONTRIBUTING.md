# Contributing to MDM VS Code Extension

Thank you for your interest in contributing!

## Prerequisites

- [Bun](https://bun.sh/) >=1.0.0
- [Visual Studio Code](https://code.visualstudio.com/) >=1.85.0
- Git

## Setup

```bash
git clone https://github.com/sethcarney/mdm-vscode.git
cd mdm-vscode
bun install
bun run compile
```

## Development Workflow

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `bun run compile` to verify TypeScript compiles cleanly
4. Run `bun run lint` to check for lint errors
5. Test manually via the Extension Development Host (`F5` in VS Code)
6. Submit a pull request

## Branch Naming

- `feat/description` — new features
- `fix/description` — bug fixes
- `docs/description` — documentation changes
- `chore/description` — maintenance tasks

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add keyboard shortcut for refresh
fix: handle missing CLI gracefully on Windows
docs: update contributing guidelines
chore: bump dependencies
```

## Pull Request Guidelines

- Keep PRs focused on a single concern
- Ensure CI passes before requesting review
- For significant changes, open an issue first to discuss the approach

## Code Style

- TypeScript with strict mode enabled
- ESLint: `bun run lint`
- Prettier: `.prettierrc` is provided for editor integration; there is no automated format check

## Releasing

Bump the version in `package.json` and push to `main`. The release workflow automatically detects the new version, packages the extension, generates SLSA provenance, and creates a GitHub release.

## License

By contributing, you agree your contributions will be licensed under the [Apache-2.0 License](LICENSE).
