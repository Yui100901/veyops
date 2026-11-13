import 'reflect-metadata';
import '../config';
import { DatabaseService } from './database.service';
async function main() {
  const database = new DatabaseService();
  try {
    await database.onModuleInit();
    console.log('Database migrations completed');
  } finally {
    await database.onModuleDestroy();
  }
}
void main().catch(() => {
  console.error('Database migration failed; check database configuration');
  process.exitCode = 1;
});
