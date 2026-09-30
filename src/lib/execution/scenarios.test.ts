import { describe, expect, it } from 'vitest';
import { runScenario, type Scenario } from './conformance';

const files = import.meta.glob<Scenario>('./scenarios/*.json', { eager: true, import: 'default' });

describe('execution conformance scenarios (TS reference core)', () => {
    it('has scenarios', () => {
        expect(Object.keys(files).length).toBeGreaterThanOrEqual(20);
    });
    for (const [file, sc] of Object.entries(files)) {
        it(`${sc.name} — ${file}`, () => {
            expect(runScenario(sc)).toEqual([]);
        });
    }
});
