# Dockplane

Dockplane is a self-hosted control plane for managing Docker across multiple hosts.

It is designed to give operators one place to inspect and operate Docker hosts, containers and Compose workloads without turning the product into a general-purpose infrastructure management suite.

## Product Direction

Dockplane focuses on:

- multi-host Docker management
- safe lifecycle operations
- Docker Compose visibility and operations
- logs and operational context
- host and workload metrics
- health and events
- secure agent communication
- resource-scoped permissions
- audit history
- self-hosted operation

## Architecture

```text
Browser
  │
  ├── Public Website
  │
  └── Dockplane Application
          │
          ▼
    Dockplane Control Server
          │
          ├── PostgreSQL
          │
          └── authenticated agent channel
                    │
                    ▼
               Dockplane Agent
                    │
                    ▼
               Docker Engine
```

The agent exposes explicit operational capabilities. It is not a generic remote-shell gateway.

## Repository Layout

```text
website/    public marketing and documentation website (Angular, prerendered)
app/        authenticated control-plane interface (Angular)
docs/       product, design, architecture and operations documentation
```

The website is built and deployed independently from the control server; see
`website/README.md`. The application is deployed with the control server and
reads it over HTTP; see `app/README.md`.

## Documentation

Key documents:

```text
ARCHITECTURE.md
SECURITY.md
docs/product/PRODUCT_SCOPE.md
docs/design/BRAND_SPEC.md
docs/design/WEBSITE_SPEC.md
docs/design/APP_UI_SPEC.md
docs/architecture/agent-protocol.md
docs/architecture/security-model.md
docs/integrations/docker.md
docs/operations/container-lifecycle.md
docs/operations/container-logs.md
```

## Brand

The approved design direction is documented in `docs/design/BRAND_SPEC.md`.

The visual references are available under:

```text
design-reference/dockplane-logo-approved-reference.png
design-reference/app-ui/
```

## Status

The public website, the control server, the agent and the control-plane interface are implemented. Dockplane discovers hosts, containers and Compose projects, can start, stop and restart a discovered container, and can read and follow container logs. Everything else the Docker API exposes — remove, exec, attach, Compose deploy, image and volume changes — is deliberately not implemented.

Documentation describes only behavior that exists.

## License

Dockplane is free software, licensed under the GNU Affero General Public
License version 3 only (`AGPL-3.0-only`). The full text is in
[LICENSE](LICENSE).

Running a modified Dockplane as a network service means offering its users the
corresponding source. That is the point of the AGPL and the reason it was
chosen for a self-hosted control plane.
