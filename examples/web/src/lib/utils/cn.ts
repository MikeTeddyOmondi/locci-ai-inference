import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Utility function to merge class names with proper Tailwind CSS class conflict resolution.
 * Combines clsx (for conditional classes) with tailwind-merge (for Tailwind-specific merging).
 */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
