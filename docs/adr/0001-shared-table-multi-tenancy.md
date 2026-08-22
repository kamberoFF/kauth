# Shared tables tagged by `project_id`, not schema/DB-per-tenant

kauth is becoming a multi-tenant platform (see `.scratch/clerk-clone/map.md`).
The alternative to a shared-table model was schema-per-tenant or
database-per-tenant isolation. We chose a single shared schema where every
user-owned table (`User`, `Account`, `Session`, `RefreshToken`,
`RecoveryToken`, `SecurityEvent`) carries a `project_id` column, with
uniqueness constraints (e.g. email, username) scoped to `(project_id, ...)`
instead of globally — greenfield, so there was no existing deployment or data
forcing the simpler path. Session/JWT carry a `projectId` claim, checked in
`requireAuth` alongside `userId`, so scoping costs no extra query.

Schema/DB-per-tenant would give stronger physical isolation and simpler
per-tenant backup/restore, but multiplies migration and connection-pooling
complexity by tenant count — not worth it before the platform has proven it
needs that isolation. Revisit if a tenant ever needs guaranteed physical
data separation (e.g. a compliance requirement), since retrofitting that
onto a shared-table model is a genuine migration, not a config change.
