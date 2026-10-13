<script lang="ts" module>
	import type { ImageAttachment } from '$lib/images';

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
		images: ImageAttachment[];
		webSearch: boolean;
	}
</script>

<script lang="ts">
	import { ArrowUp, Globe, Image, Mic, Paperclip, Plus, Square, X } from '@lucide/svelte';
	import { onDestroy } from 'svelte';
	import { brand } from '$lib/brand';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { currentModel, ui } from '$lib/state/ui.svelte';
	import { IMAGE_ACCEPT, prepareImage } from '$lib/images';
	import FileChip from './FileChip.svelte';
	import IconButton from './IconButton.svelte';
	import ImageChip from './ImageChip.svelte';
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

	// Files the model can read as text. Photos go separately, to models that read images.
	const TEXT_EXTENSIONS =
		'.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.yaml,.yml,.toml,.xml,.html,.css,.js,.mjs,.ts,.tsx,.jsx,.svelte,.py,.go,.rs,.java,.kt,.rb,.php,.c,.h,.cpp,.cs,.sh,.sql,.log,.env.example';
	const MAX_FILES = 5;
	const MAX_FILE_BYTES = 500_000;
	/** A paste longer than this becomes an attached "Pasted text" file, like a file upload. */
	const PASTE_AS_FILE_CHARS = 2_000;
	const PASTE_AS_FILE_LINES = 30;
	/** The text box grows to ~10 lines, then scrolls inside. */
	const MAX_HEIGHT = 256;

	let text = $state('');
	let attachments = $state<Attachment[]>([]);
	let images = $state<ImageAttachment[]>([]);
	let webSearch = $state(false);
	// Photos need a model that reads images; unknown (list not loaded) counts as not.
	const canSeeImages = $derived(currentModel()?.images ?? false);
	/** Photos are attached but the picked model can't read them: Send waits for a switch. */
	const needsImageModel = $derived(images.length > 0 && !canSeeImages);
	let dragging = $state(false);
	// Web search runs as a tool call, so it only applies to models with tools.
	// Unknown (list not loaded yet) counts as capable; the API decides anyway.
	const canUseTools = $derived(currentModel()?.tools ?? true);
	const searchOn = $derived(webSearch && canUseTools);
	let notice = $state('');
	let textarea: HTMLTextAreaElement | undefined = $state();
	let fileInput: HTMLInputElement | undefined = $state();
	let imageInput: HTMLInputElement | undefined = $state();

	const fileCount = $derived(attachments.length + images.length);
	const canSend = $derived(
		!disabled && !busy && !needsImageModel && (text.trim().length > 0 || fileCount > 0)
	);

	$effect(() => {
		if (autofocus && textarea && !disabled) textarea.focus({ preventScroll: true });
	});

	/** Grow with the content up to ~10 lines, then scroll inside. */
	function resize() {
		if (!textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_HEIGHT)}px`;
	}

	/**
	 * The model only reads `ui.maxInputChars` characters of a conversation (the
	 * API shortens anything longer), so say so up front rather than silently.
	 */
	function warnIfLong() {
		const total = text.length + attachments.reduce((n, a) => n + a.text.length, 0);
		if (ui.maxInputChars && total > ui.maxInputChars) {
			flash(`Long text: the model reads about the first ${ui.maxInputChars.toLocaleString()} characters.`);
		}
	}

	/** Large pastes become an attachment chip instead of flooding the text box; pasted images attach. */
	function onPaste(e: ClipboardEvent) {
		const pastedImages = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
		if (pastedImages.length > 0) {
			e.preventDefault();
			void addImages(pastedImages);
			return;
		}
		const pasted = e.clipboardData?.getData('text/plain') ?? '';
		const lines = pasted.split('\n').length;
		if (pasted.length < PASTE_AS_FILE_CHARS && lines < PASTE_AS_FILE_LINES) return;
		e.preventDefault();
		if (fileCount >= MAX_FILES) {
			flash(`Up to ${MAX_FILES} files per message.`);
			return;
		}
		const looksLikeMarkdown = /^(#{1,6} |```|[-*] |> )/m.test(pasted);
		const n = attachments.filter((a) => a.name.startsWith('Pasted text')).length + 1;
		const name = `Pasted text${n > 1 ? ` (${n})` : ''}.${looksLikeMarkdown ? 'md' : 'txt'}`;
		attachments.push({ id: crypto.randomUUID(), name, size: new Blob([pasted]).size, text: pasted });
		warnIfLong();
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
		const payload: ComposerSubmit = {
			text: text.trim(),
			attachments: [...attachments],
			images: [...images],
			webSearch: searchOn
		};
		text = '';
		attachments = [];
		images = [];
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

	async function addFiles(list: FileList | File[] | null) {
		if (!list) return;
		for (const file of Array.from(list)) {
			if (fileCount >= MAX_FILES) {
				flash(`Up to ${MAX_FILES} files per message.`);
				break;
			}
			if (file.size > MAX_FILE_BYTES) {
				flash(`${file.name} is too large (max ${Math.round(MAX_FILE_BYTES / 1000)} KB).`);
				continue;
			}
			const content = await file.text();
			attachments.push({ id: crypto.randomUUID(), name: file.name, size: file.size, text: content });
		}
		if (fileInput) fileInput.value = '';
		warnIfLong();
	}

	function removeAttachment(id: string) {
		attachments = attachments.filter((a) => a.id !== id);
	}

	/** Photos are resized in the browser (lib/images.ts) before they are attached. */
	async function addImages(list: FileList | File[] | null) {
		if (!list) return;
		if (!canSeeImages) flash('This model can\'t read photos. Pick one that can, such as gemma-4-e2b.');
		for (const file of Array.from(list)) {
			if (fileCount >= MAX_FILES) {
				flash(`Up to ${MAX_FILES} files per message.`);
				break;
			}
			try {
				images.push(await prepareImage(file));
			} catch {
				flash(`${file.name || 'That image'} couldn't be read.`);
			}
		}
		if (imageInput) imageInput.value = '';
	}

	function removeImage(id: string) {
		images = images.filter((i) => i.id !== id);
	}

	/** Dropped files: photos as photos, everything else as text files. */
	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		if (disabled) return;
		const files = Array.from(e.dataTransfer?.files ?? []);
		const photos = files.filter((f) => f.type.startsWith('image/'));
		const others = files.filter((f) => !f.type.startsWith('image/'));
		if (photos.length > 0) void addImages(photos);
		if (others.length > 0) void addFiles(others);
	}

	function onDragOver(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		dragging = true;
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
		class={[
			'rounded-[26px] border bg-secondary p-2 shadow-sm transition-shadow focus-within:shadow-md dark:shadow-none',
			dragging && 'border-brand ring-2 ring-brand/30'
		]}
		role="group"
		aria-label="Message composer"
		ondragover={onDragOver}
		ondragleave={() => (dragging = false)}
		ondrop={onDrop}
	>
		{#if images.length > 0}
			<ul class="flex flex-wrap gap-3 px-1.5 pt-2 pb-2" aria-label="Photos">
				{#each images as image (image.id)}
					<li>
						<ImageChip name={image.name} url={image.url} onRemove={() => removeImage(image.id)} />
					</li>
				{/each}
			</ul>
		{/if}
		{#if attachments.length > 0}
			<ul class="flex flex-wrap gap-2 px-1 pt-1 pb-2" aria-label="Attachments">
				{#each attachments as file (file.id)}
					<li class="max-w-full min-w-0 sm:max-w-72">
						<FileChip name={file.name} size={file.size} text={file.text} onRemove={() => removeAttachment(file.id)} />
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
				onpaste={onPaste}
				rows="1"
				placeholder={brand.placeholder}
				aria-label="Message"
				{disabled}
				class="order-1 max-h-64 min-h-10 overflow-y-auto basis-full resize-none border-0 bg-transparent px-2 py-2 text-base leading-6 text-foreground placeholder:text-muted-foreground focus:ring-0"
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
				<input
					bind:this={imageInput}
					type="file"
					multiple
					accept={IMAGE_ACCEPT}
					class="hidden"
					onchange={(e) => addImages((e.currentTarget as HTMLInputElement).files)}
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
						<DropdownMenu.Item disabled={!canSeeImages} onSelect={() => imageInput?.click()}>
							<Image class="text-muted-foreground" />
							<span class="flex flex-col">
								Add photos
								{#if !canSeeImages}<span class="text-xs text-muted-foreground">Not available with this model</span>{/if}
							</span>
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
		{notice || (needsImageModel ? "This model can't read photos. Pick one that can, such as gemma-4-e2b." : brand.disclaimer)}
	</p>
</div>
