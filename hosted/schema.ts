import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable('accounts', {
  userId: text('user_id').primaryKey().notNull(),
  createdAt: text('created_at').notNull(),
});

export const tracks = sqliteTable('tracks', {
  ownerId: text('owner_id').notNull().references(() => accounts.userId),
  id: text('id').notNull(),
  createdAt: text('created_at').notNull(),
  payload: text('payload').notNull(),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.id] }),
  index('tracks_owner_created').on(table.ownerId, table.createdAt, table.id),
]);

export const libraryWrites = sqliteTable('library_writes', {
  ownerId: text('owner_id').notNull().references(() => accounts.userId),
  receipt: text('receipt').notNull(),
  atMs: integer('at_ms').notNull(),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.receipt] }),
  index('library_writes_owner_time').on(table.ownerId, table.atMs),
]);
