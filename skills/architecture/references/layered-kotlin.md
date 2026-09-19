# Layered placement — Kotlin/Spring

Packaging is by technical role, and calls only ever go **downward**: web → service → repository → database. This is the right default for most applications; it needs no ports and no events.

```
apps/api/src/main/kotlin/app/
├── controller/
│   └── BookmarkController.kt      @RestController, request/response DTOs
├── service/
│   └── BookmarkService.kt         @Service, the rules and the transaction boundary
├── repository/
│   └── BookmarkRepository.kt      Spring Data interface
├── domain/                        (or model/) the @Entity types
│   └── Bookmark.kt                @Entity lives HERE in this style — that is correct
└── config/
    └── SecurityConfig.kt
```

## Where each kind of new code goes

| The test drives… | Put it in | Notes |
|---|---|---|
| Request validation, a status code | `controller/` | Bean validation annotations on the DTO, not hand-rolled ifs |
| A business rule | `service/` | The rule lives with the transaction that applies it |
| A query | `repository/` | A derived method name first; `@Query` only when that cannot express it |
| A new field on a persisted type | `domain/` entity, plus a migration | Entity and migration change together, always |
| Something cross-cutting (auth, CORS) | `config/` | Not in a controller |
| A new endpoint | `controller/` + `service/` | One controller method, one service method |

## MVC is this file, with the service layer collapsed

If `architecture.style` is `mvc`, the controller talks to the repository directly and there is no `service/`. Everything above still holds, with one substitution: **the rule goes in the controller** and the transaction boundary is the controller method. The moment a rule needs to be reused by a second entry point, that is the signal to introduce `service/` — and that is its own change with its own acceptance criterion, not something to do in passing.

## Imports, allowed and not

- `controller/` imports `service/` and `domain/`.
- `service/` imports `repository/` and `domain/`.
- **`repository/` imports `domain/` only.** A repository importing a controller or a service is upward and wrong; `keel verify arch` enforces this with `no-controller-in-repository`.
- `domain/` entities import JPA. That is expected here, unlike hexagonal.

## The two mistakes this style invites

**A service that is only a pass-through.** `fun findAll() = repo.findAll()` adds a file and no behaviour. Let the controller call the repository until a rule actually exists — then the service appears with the rule in it.

**An anaemic service holding another layer's job.** A `service/` method doing request parsing, or building a response DTO, has taken the controller's work. Keep mapping at the edge.

## Two smaller traps

- **An entity used as the response body.** It leaks the schema and couples the API to the table. Map to a DTO in `controller/`.
- **`@Transactional` on the controller.** The transaction belongs to the service method that owns the rule.
