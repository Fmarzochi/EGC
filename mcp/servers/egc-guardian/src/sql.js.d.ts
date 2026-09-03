declare module 'sql.js' {
  const initSqlJs: (config?: Record<string, unknown>) => Promise<unknown>;
  export default initSqlJs;
}
