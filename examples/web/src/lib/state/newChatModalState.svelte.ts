// Shared state for the NewChatModal
let isOpen = $state(false);

export const newChatModalState = {
	get isOpen() {
		return isOpen;
	},
	open() {
		isOpen = true;
	},
	close() {
		isOpen = false;
	}
};
