import { join } from 'path';
import { DataSource, EntityMetadata } from 'typeorm';
import { testDbConfig } from '../setup/test-db';

/**
 * db/schema.sql(SSOT)과 TypeORM 엔티티 매핑이 어긋나지 않는지 검증한다.
 * synchronize를 쓰지 않으므로, 이 테스트가 엔티티와 스키마 사이의 유일한 안전망이다.
 */

// TypeORM 컬럼 타입 → PostgreSQL udt_name
const UDT_NAME: Record<string, string> = {
  uuid: 'uuid',
  varchar: 'varchar',
  char: 'bpchar',
  text: 'text',
  bigint: 'int8',
  integer: 'int4',
  smallint: 'int2',
  boolean: 'bool',
  timestamptz: 'timestamptz',
  jsonb: 'jsonb',
  bytea: 'bytea',
};

interface DbColumn {
  table_name: string;
  column_name: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  character_maximum_length: number | null;
}

interface DbForeignKey {
  table_name: string;
  ref_table: string;
  columns: string[];
  ref_columns: string[];
}

describe('엔티티 ↔ db/schema.sql 적합성', () => {
  let dataSource: DataSource;
  let dbTables: string[];
  let dbColumns: DbColumn[];
  let dbPrimaryKeys: Map<string, string[]>;
  let dbForeignKeys: DbForeignKey[];

  const entities = () => dataSource.entityMetadatas;
  const columnsOf = (table: string) => dbColumns.filter((c) => c.table_name === table);

  beforeAll(async () => {
    const { host, port, user, password, database } = testDbConfig();
    dataSource = new DataSource({
      type: 'postgres',
      host,
      port,
      username: user,
      password: password as string,
      database,
      entities: [join(__dirname, '..', '..', 'src', '**', 'domain', '*.entity.ts').replace(/\\/g, '/')],
      synchronize: false,
    });
    await dataSource.initialize();

    dbTables = (
      await dataSource.query<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      )
    ).map((r) => r.table_name);

    dbColumns = await dataSource.query<DbColumn[]>(
      `SELECT table_name, column_name, udt_name, is_nullable, character_maximum_length
         FROM information_schema.columns WHERE table_schema = 'public'`,
    );

    const pkRows = await dataSource.query<{ table_name: string; columns: string[] }[]>(
      `SELECT c.conrelid::regclass::text AS table_name,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns
         FROM pg_constraint c
        WHERE c.contype = 'p' AND c.connamespace = 'public'::regnamespace`,
    );
    dbPrimaryKeys = new Map(pkRows.map((r) => [r.table_name, [...r.columns].sort()]));

    dbForeignKeys = await dataSource.query<DbForeignKey[]>(
      `SELECT c.conrelid::regclass::text  AS table_name,
              c.confrelid::regclass::text AS ref_table,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
              (SELECT array_agg(a.attname::text ORDER BY k.ord)
                 FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS ref_columns
         FROM pg_constraint c
        WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('DB의 모든 테이블에 엔티티가 하나씩 있다', () => {
    const entityTables = entities().map((e) => e.tableName);

    expect([...entityTables].sort()).toEqual([...dbTables].sort());
  });

  it('엔티티 컬럼과 DB 컬럼이 양방향으로 빠짐없이 일치한다', () => {
    const mismatches: string[] = [];
    for (const entity of entities()) {
      const entityCols = new Set(entity.columns.map((c) => c.databaseName));
      const dbCols = new Set(columnsOf(entity.tableName).map((c) => c.column_name));
      for (const col of dbCols) if (!entityCols.has(col)) mismatches.push(`${entity.tableName}.${col}: 엔티티에 없음`);
      for (const col of entityCols) if (!dbCols.has(col)) mismatches.push(`${entity.tableName}.${col}: DB에 없음`);
    }

    expect(mismatches).toEqual([]);
  });

  it('컬럼 타입·길이·nullable이 DB와 일치한다', () => {
    const mismatches: string[] = [];
    for (const entity of entities()) {
      for (const col of entity.columns) {
        const db = columnsOf(entity.tableName).find((c) => c.column_name === col.databaseName);
        if (!db) continue; // 존재 여부는 위 테스트가 검증
        const where = `${entity.tableName}.${col.databaseName}`;

        const type = typeof col.type === 'string' ? col.type : String(col.type);
        if (UDT_NAME[type] !== db.udt_name) mismatches.push(`${where}: type ${type} ≠ ${db.udt_name}`);

        if (db.character_maximum_length !== null && Number(col.length) !== db.character_maximum_length) {
          mismatches.push(`${where}: length ${col.length || '(없음)'} ≠ ${db.character_maximum_length}`);
        }

        if (col.isNullable !== (db.is_nullable === 'YES')) {
          mismatches.push(`${where}: nullable ${col.isNullable} ≠ ${db.is_nullable}`);
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('기본키가 DB와 일치한다', () => {
    const mismatches: string[] = [];
    for (const entity of entities()) {
      const entityPk = entity.primaryColumns.map((c) => c.databaseName).sort();
      const dbPk = dbPrimaryKeys.get(entity.tableName) ?? [];
      if (entityPk.join(',') !== dbPk.join(',')) {
        mismatches.push(`${entity.tableName}: PK (${entityPk.join(',')}) ≠ (${dbPk.join(',')})`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('엔티티의 관계(FK)는 모두 DB에 실제로 존재하는 FK다', () => {
    const describeFk = (entity: EntityMetadata, fk: EntityMetadata['foreignKeys'][number]) =>
      `${entity.tableName}(${fk.columnNames.join(',')}) → ${fk.referencedTablePath}(${fk.referencedColumnNames.join(',')})`;

    const mismatches: string[] = [];
    for (const entity of entities()) {
      for (const fk of entity.foreignKeys) {
        const exists = dbForeignKeys.some(
          (db) =>
            db.table_name === entity.tableName &&
            db.ref_table === fk.referencedTablePath &&
            db.columns.join(',') === fk.columnNames.join(',') &&
            db.ref_columns.join(',') === fk.referencedColumnNames.join(','),
        );
        if (!exists) mismatches.push(`${describeFk(entity, fk)}: DB에 없는 FK`);
      }
    }

    expect(mismatches).toEqual([]);
  });
});
