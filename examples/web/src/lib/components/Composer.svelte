<script lang="ts" module>
	/** A text file read in the browser and sent to the model as context. */
	export interface Attachment {
		id: string;
		name: string;
		size: number;
		text: string;
	}

	export interface ComposerSubmit {
		text: string;
		attachments: Attachment[];
		webSearch: boolean;
	}
</script>

<script lang="ts">
	import { ArrowUp, FileText, Globe, Image, Mic, Paperclip, Plus, Square, X } from '@lucide/svelte';
	import { onDestroy } from 'svelte';
	import { brand } from '$lib/brand';
	import { Badge } from '$lib/components/ui/badge';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { currentModel } from '$lib/state/ui.svelte';
	import IconButton from './IconButton.svelte';
	import ModelPicker from './ModelPicker.svelte';

	interface Props {
		onSubmit: (input: ComposerSubmit) => void | Promise<void>;
		onStop?: () => void;
		/** A reply is streaming: Send becomes Stop. */
		busy?: boolean;
		disabled?: boolean;
		autofocus?: boolean;
	}

	const { onSubmit, onStop, busy = false, disabled = false, autofocus = false }: Props = $props();

	// Files the model can read as text. Images need a vision model (coming later).
	const TEXT_EXTENSIONS =
		'.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.yaml,.yml,.toml,.xml,.html,.css,.js,.mjs,.ts,.tsx,.jsx,.svelte,.py,.go,.rs,.java,.kt,.rb,.php,.c,.h,.cpp,.cs,.sh,.sql,.log,.env.example';
	const MAX_FILES = 5;
	const MAX_FILE_BYTES = 200_000;
	/** Keeps attachments inside the model's per-request window (~8k tokens). */
	const MAX_TOTAL_CHARS = 20_000;

	let text = $state('');
	let attachments = $state<Attachment[]>([]);
	let webSearch = $state(false);
	// Web search runs as a tool call, so it only applies to models with tools.
	// Unknown (list not loaded yet) counts as capable; the API decides anyway.
	const canUseTools = $derived(currentModel()?.tools ?? true);
	const searchOn = $derived(webSearch && canUseTools);
	let notice = $state('');
	let textarea: HTMLTextAreaElement | undefined = $state();
	let fileInput: HTMLInputElement | undefined = $state();

	const canSend = $derived(!disabled && !busy && (text.trim().length > 0 || attachments.length > 0));

	$effect(() => {
		if (autofocus && textarea && !disabled) textarea.focus({ preventScroll: true });
	});

	/** Grow with the content up to ~8 lines, then scroll inside. */
	function resize() {
		if (!textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = `${Math.min(textarea.scrollHeight, 208)}px`;
	}

	$effect(() => {
		void text; // re-run when the text changes (typing, dictation, clearing)
		resize();
	});

	function flash(message: string) {
		notice = message;
		setTimeout(() => {
			if (notice === message) notice = '';
		}, 4000);
	}

	async function submit() {
		if (!canSend) return;
		const payload: ComposerSubmit = { text: text.trim(), attachments: [...attachments], webSearch: searchOn };
		text = '';
		attachments = [];
		stopListening();
		await onSubmit(payload);
		textarea?.focus({ preventScroll: true });
	}

	function onKeydown(e: KeyboardEvent) {
		// Enter sends, Shift+Enter adds a line. On touch keyboards Enter inserts a
		// newline (there's a Send button), as mobile chat apps do. Cmd/Ctrl+Enter
		// always sends, including from a hardware keyboard on a tablet.
		if (e.key !== 'Enter' || e.isComposing) return;
		const touch = window.matchMedia('(pointer: coarse)').matches;
		if (e.metaKey || e.ctrlKey || (!e.shiftKey && !touch)) {
			e.preventDefault();
			submit();
		}
	}

	async function addFiles(list: FileList | null) {
		if (!list) return;
		let used = attachments.reduce((n, a) => n + a.text.length, 0);
		for (const file of Array.from(list)) {
			if (attachments.length >= MAX_FILES) {
				flash(`Up to ${MAX_FILES} files per message.`);
				break;
			}
			if (file.size > MAX_FILE_BYTES) {
				flash(`${file.name} is too large (max ${Math.round(MAX_FILE_BYTES / 1000)} KB).`);
				continue;
			}
			let content = await file.text();
			if (used + content.length > MAX_TOTAL_CHARS) {
				content = content.slice(0, Math.max(0, MAX_TOTAL_CHARS - used));
				flash(`${file.name} was truncated to fit the model's context.`);
			}
			used += content.length;
			attachments.push({ id: crypto.randomUUID(), name: file.name, size: file.size, text: content });
		}
		if (fileInput) fileInput.value = '';
	}

	function removeAttachment(id: string) {
		attachments = attachments.filter((a) => a.id !== id);
	}

	// --- Voice input (Web Speech API) ---------------------------------------
	// Dictation into the text box: interim words show live, final words stick.
	// Chrome, Edge and Safari implement it (prefixed); Firefox does not, so the
	// button explains that instead of failing silently.

	interface RecognitionResult {
		isFinal: boolean;
		0: { transcript: string };
	}
	interface Recognition {
		lang: string;
		continuous: boolean;
		interimResults: boolean;
		onresult: ((e: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
		onerror: ((e: { error: string }) => void) | null;
		onend: (() => void) | null;
		start(): void;
		stop(): void;
	}
	type RecognitionCtor = new () => Recognition;

	const Speech: RecognitionCtor | undefined =
		typeof window === 'undefined'
			? undefined
			: ((window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor })
					.SpeechRecognition ??
				(window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition);

	let recognition: Recognition | null = null;
	let listening = $state(false);
	let baseText = '';

	function startListening() {
		if (!Speech) {
			flash("Voice input isn't supported in this browser. Try Chrome, Edge or Safari.");
			return;
		}
		recognition = new Speech();
		recognition.lang = navigator.language || 'en-US';
		recognition.continuous = true;
		recognition.interimResults = true;
		baseText = text ? `${text.trimEnd()} ` : '';
		recognition.onresult = (e) => {
			let finalText = '';
			let interim = '';
			for (let i = 0; i < e.results.length; i++) {
				const r = e.results[i];
				if (r.isFinal) finalText += r[0].transcript;
				else interim += r[0].transcript;
			}
			text = baseText + finalText + interim;
		};
		recognition.onerror = (e) => {
			if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
				flash('Microphone access was blocked. Allow it in your browser settings.');
			} else if (e.error !== 'aborted' && e.error !== 'no-speech') {
				flash(`Voice input stopped: ${e.error}`);
			}
		};
		recognition.onend = () => {
			listening = false;
			recognition = null;
		};
		recognition.start();
		listening = true;
	}

	function stopListening() {
		recognition?.stop();
		listening = false;
	}

	onDestroy(stopListening);
</script>

<div class="w-full">
	<div
		class="rounded-[26px] border bg-secondary p-2 shadow-sm transition-shadow focus-within:shadow-md dark:shadow-none"
	>
		{#if attachments.length > 0}
			<ul class="flex flex-wrap gap-2 px-1 pt-1 pb-2" aria-label="Attachments">
				{#each attachments as file (file.id)}
					<li class="flex max-w-full items-center gap-2 rounded-xl border bg-background py-1.5 pr-1.5 pl-2.5 text-xs">
						<FileText class="size-4 shrink-0 text-muted-foreground" />
						<span class="truncate font-medium">{file.name}</span>
						<span class="shrink-0 text-muted-foreground">{(file.size / 1000).toFixed(1)} KB</span>
						<Button
							variant="subtle"
							size="icon-xs"
							class="rounded-full"
							aria-label={`Remove ${file.name}`}
							onclick={() => removeAttachment(file.id)}
						>
							<X />
						</Button>
					</li>
				{/each}
			</ul>
		{/if}

		<!-- Two rows on every screen: the text box on top, the controls (+, model,
		     voice, send) on their own row underneath, inside the same card. -->
		<div class="flex flex-wrap items-end gap-1">
			<textarea
				bind:this={textarea}
				bind:value={text}
				onkeydown={onKeydown}
				rows="1"
				placeholder={brand.placeholder}
				aria-label="Message"
				{disabled}
				class="order-1 max-h-52 min-h-10 basis-full resize-none border-0 bg-transparent px-2 py-2 text-base leading-6 text-foreground placeholder:text-muted-foreground focus:ring-0"
			></textarea>

			<div class="order-2 flex min-w-0 items-center gap-1">
				<input
					bind:this={fileInput}
					type="file"
					multiple
					accept={TEXT_EXTENSIONS}
					class="hidden"
					onchange={(e) => addFiles((e.currentTarget as HTMLInputElement).files)}
				/>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger
						class={buttonVariants({ variant: 'subtle', size: 'icon-round' })}
						aria-label="Add files and more"
						{disabled}
					>
						<Plus />
					</DropdownMenu.Trigger>
					<DropdownMenu.Content side="top" align="start" sideOffset={8} class="min-w-60">
						<DropdownMenu.Item onSelect={() => fileInput?.click()}>
							<Paperclip class="text-muted-foreground" />
							Add files
							<span class="ml-auto text-xs text-muted-foreground">text &amp; code</span>
						</DropdownMenu.Item>
						<DropdownMenu.Item disabled>
							<Image class="text-muted-foreground" />
							Add photos
							<Badge variant="secondary" class="ml-auto">Soon</Badge>
						</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.CheckboxItem bind:checked={webSearch} disabled={!canUseTools}>
							<Globe class="text-muted-foreground" />
							<span class="flex flex-col">
								Search the web
								{#if !canUseTools}<span class="text-xs text-muted-foreground">Not available with this model</span>{/if}
							</span>
						</DropdownMenu.CheckboxItem>
					</DropdownMenu.Content>
				</DropdownMenu.Root>


				{#if searchOn}
					<Button
						variant="ghost"
						class="h-9 rounded-full bg-brand/15 px-3 text-brand hover:bg-brand/20 hover:text-brand"
						aria-label="Web search is on for the next message. Turn off"
						onclick={() => (webSearch = false)}
					>
						<Globe />
						<span class="hidden min-[380px]:inline">Search</span>
						<X class="size-3.5" />
					</Button>
				{/if}
			</div>

			<div class="order-3 ml-auto flex min-w-0 items-center gap-1">
				<ModelPicker {disabled} />
				<IconButton
					side="top"
					label={Speech ? (listening ? 'Stop voice input' : 'Voice input') : "Voice input isn't supported in this browser"}
					aria-pressed={listening}
					onclick={() => (listening ? stopListening() : startListening())}
					class={listening ? 'bg-destructive/15 text-destructive hover:bg-destructive/20 hover:text-destructive' : ''}
					{disabled}
				>
					{#if listening}
						<span class="relative flex size-5 items-center justify-center">
							<span class="absolute inline-flex size-full animate-ping rounded-full bg-destructive/40"></span>
							<Mic class="relative" />
						</span>
					{:else}
						<Mic />
					{/if}
				</IconButton>
				<!-- Send (or Stop) is always the last control. -->
				{#if busy}
					<Button size="icon-round" aria-label="Stop generating" onclick={() => onStop?.()}>
						<Square class="size-3.5 fill-current" />
					</Button>
				{:else}
					<Button
						size="icon-round"
						class="bg-brand text-white hover:bg-brand-hover disabled:bg-accent disabled:text-muted-foreground disabled:opacity-100"
						aria-label="Send message"
						disabled={!canSend}
						onclick={submit}
					>
						<ArrowUp />
					</Button>
				{/if}
			</div>
		</div>
	</div>

	<p class="mt-2 min-h-4 px-2 text-center text-xs text-muted-foreground" aria-live="polite">
		{notice || brand.disclaimer}
	</p>
</div>
