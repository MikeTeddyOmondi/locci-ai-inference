// localbase ships no types; this covers the calls threads.ts makes.
declare module 'localbase' {
	interface Doc {
		get(): Promise<unknown>;
		set(value: unknown): Promise<unknown>;
		delete(): Promise<unknown>;
	}
	interface Collection {
		get(): Promise<unknown[]>;
		add(value: unknown): Promise<unknown>;
		delete(): Promise<unknown>;
		doc(criteria: Record<string, unknown>): Doc;
	}
	export default class Localbase {
		constructor(name: string);
		config: { debug: boolean };
		collection(name: string): Collection;
	}
}
