import { db } from '@suiftly/database';
import { mockTrackingObjects } from '@suiftly/database/schema';

async function clean() {
  const result = await db.delete(mockTrackingObjects);
  console.log('Cleaned all tracking objects');
  process.exit(0);
}

clean().catch(console.error);