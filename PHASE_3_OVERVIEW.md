# Phase 3: Shared Types & Validation - Overview

**Question:** What will Phase 3 (Zod) add and will it be hard to modify the schema moving forward?

---

## What Phase 3 Adds

### **Purpose: Runtime Validation + Type Safety**

Phase 3 creates **Zod schemas** in `packages/shared` that:

1. **Validate API requests/responses at runtime**
   - Frontend: Form validation before submit
   - Backend: API input validation before database
   - Prevents bad data from reaching database

2. **Share types between frontend and backend**
   - Type-safe tRPC calls
   - Consistent validation rules everywhere
   - Single source of truth for data shapes

3. **Generate TypeScript types automatically**
   - `z.infer<typeof CustomerSchema>` → TypeScript type
   - No manual type definitions needed
   - Types always match validation rules

---

## What Phase 3 Does NOT Add

- ❌ **No database schema changes** - Database stays exactly as-is
- ❌ **No new tables** - Works with existing 13 tables
- ❌ **No migrations** - Pure TypeScript code, no DB impact

---

## Example: What Gets Created

**Database Schema (Phase 2 - already done):**
```typescript
// packages/database/src/schema/customers.ts
export const customers = pgTable('customers', {
  customerId: integer('customer_id').primaryKey(),
  walletAddress: varchar('wallet_address', { length: 66 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  // ... other fields
});
```

**Zod Schema (Phase 3 - next):**
```typescript
// packages/shared/src/schemas/customer.ts
export const CustomerSchema = z.object({
  customerId: z.number().int().positive(),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  status: z.enum(['active', 'suspended', 'closed']),
  maxMonthlyUsdCents: z.number().int().min(2000).nullable(), // $20 minimum
  // ... validation rules
});

// Auto-generated TypeScript type
export type Customer = z.infer<typeof CustomerSchema>;
```

**Usage in API (Phase 4+):**
```typescript
// apps/api/src/routes/customers.ts
import { CustomerSchema } from '@suiftly/shared/schemas';

// tRPC endpoint with automatic validation
export const customerRouter = router({
  updateProfile: procedure
    .input(CustomerSchema.pick({ walletAddress: true, status: true }))
    .mutation(async ({ input }) => {
      // input is validated AND typed!
      // TypeScript knows: input.walletAddress is string
      // Runtime: Zod rejects invalid wallet addresses
    }),
});
```

---

## Will Schema Changes Be Hard?

### ✅ **NO! Schema changes are straightforward:**

**When you change the database schema:**

1. **Update Drizzle schema** (Phase 2 code):
   ```typescript
   // Add a new field
   export const customers = pgTable('customers', {
     // ... existing fields
     newField: varchar('new_field', { length: 50 }), // ADD THIS
   });
   ```

2. **Generate migration:**
   ```bash
   npm run db:generate  # Creates migration SQL
   npm run db:push      # Applies to database
   ```

3. **Update Zod schema** (Phase 3 code):
   ```typescript
   export const CustomerSchema = z.object({
     // ... existing validations
     newField: z.string().max(50).optional(), // ADD THIS
   });
   ```

**That's it!** 3 simple steps.

---

## Schema Change Workflow

### **Example: Adding a "phone_number" field to customers**

**Step 1: Update Drizzle Schema**
```typescript
// packages/database/src/schema/customers.ts
export const customers = pgTable('customers', {
  // ... existing fields
  phoneNumber: varchar('phone_number', { length: 20 }), // NEW
});
```

**Step 2: Generate and Apply Migration**
```bash
cd packages/database
npm run db:generate  # Creates: migrations/0001_add_phone.sql
npm run db:push      # Applies to database
```

**Step 3: Update Zod Schema**
```typescript
// packages/shared/src/schemas/customer.ts
export const CustomerSchema = z.object({
  // ... existing validations
  phoneNumber: z.string().regex(/^\+[0-9]{10,15}$/).optional(), // NEW
});
```

**Step 4: Use in Frontend/Backend** (automatic!)
```typescript
// Type is automatically updated
type Customer = z.infer<typeof CustomerSchema>;
// Customer now has phoneNumber?: string

// Validation automatically includes phone number
const result = CustomerSchema.parse(data); // Validates phone format
```

---

## Benefits of This Approach

### ✅ **Drizzle ORM (Database)**
- Generates migrations automatically
- Type-safe queries
- Change schema → regenerate → apply (simple)

### ✅ **Zod (Validation)**
- Runtime validation (catches bad data before DB)
- Type generation (no manual types)
- Change schema → update validation → done

### ✅ **Together:**
1. **Change database:** Drizzle handles migration
2. **Change validation:** Zod handles runtime checks
3. **Types update automatically:** TypeScript sees both

---

## Is It Hard to Modify?

### **NO! Here's why:**

**Without Zod (harder):**
```typescript
// Manual validation
if (!data.walletAddress || typeof data.walletAddress !== 'string') {
  throw new Error('Invalid wallet');
}
if (data.walletAddress.length !== 66) {
  throw new Error('Wrong length');
}
// ... 50 more lines of validation
```

**With Zod (easier):**
```typescript
// Automatic validation
CustomerSchema.parse(data); // One line, all rules enforced
```

**Schema changes:**
- Add field to Drizzle → generate migration → add to Zod → done
- Remove field → same process
- Rename field → Drizzle migration + Zod update

**Time:** ~5 minutes per schema change (for experienced dev)

---

## Concerns & Answers

### **Q: Do I need to update schemas in multiple places?**
**A:** Yes, but it's intentional and beneficial:
- **Database schema** (Drizzle): What can be stored
- **Validation schema** (Zod): What we accept from users
- These can differ! Example: Accept `phoneNumber` string, but store as normalized format

### **Q: What if I forget to update Zod after changing Drizzle?**
**A:**
- TypeScript will show type errors (if you use the types)
- Runtime validation will be looser (but database constraints still protect)
- Tests will catch it (if you have integration tests)

### **Q: Can I skip Zod and just use Drizzle?**
**A:** Yes, but you lose:
- ❌ Runtime validation (bad data reaches DB, rejected by constraints = poor UX)
- ❌ Frontend validation (no form error messages)
- ❌ API error messages ("validation failed" vs "email must be valid")

### **Q: Is this over-engineering?**
**A:** No - this is industry standard:
- Drizzle = ORM (database layer)
- Zod = Validation (API/form layer)
- Separation of concerns (database ≠ API contract)

---

## Recommendation

**✅ Proceed with Phase 3**

**Why:**
1. Adds runtime safety (prevents bad data)
2. Makes schema changes EASIER (automatic types)
3. Better error messages for users
4. Industry standard pattern (not over-engineering)
5. Doesn't make schema changes harder (actually makes them safer)

**Phase 3 is relatively quick:** ~1-2 hours to create Zod schemas for existing tables.

---

## Alternative: Skip Phase 3?

**If you skip Zod:**
- ✅ Can still develop everything
- ❌ Need manual validation everywhere
- ❌ No automatic type generation
- ❌ Poor error messages ("invalid data" vs "email format invalid")
- ❌ More bugs reach production

**Verdict:** Zod is worth it - small upfront cost, big ongoing benefit.

---

**Decision needed:** Proceed with Phase 3 or skip/defer?
