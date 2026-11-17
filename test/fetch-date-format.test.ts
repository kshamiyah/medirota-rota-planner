import { describe, expect, it } from 'vitest';
import { formatDateLong } from '../src/app/components/ui';
describe('formatDateLong', () => { it('uses stable British short dates without locale commas', () => { expect(formatDateLong('2026-11-02')).toBe('Mon 2 Nov'); expect(formatDateLong('2027-08-30')).toBe('Mon 30 Aug'); }); });
