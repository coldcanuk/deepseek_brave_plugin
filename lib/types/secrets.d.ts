// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * Optional secret-manager lookups, so a Brave key can live in an encrypted
 * store instead of a cleartext file.
 * @module dsh-web-search-brave/secrets
 */
/** Try the GNOME keyring, then `pass`. The default. */
export declare const SECRET_MANAGER_AUTO = "auto";
/** Disable secret-manager lookups entirely. */
export declare const SECRET_MANAGER_NONE = "none";
/** Read only from the GNOME keyring. */
export declare const SECRET_MANAGER_GNOME = "gnome-keyring";
/** Read only from `pass`. */
export declare const SECRET_MANAGER_PASS = "pass";
/** Which secret manager to consult. */
export type SecretManager = 'auto' | 'none' | 'gnome-keyring' | 'pass';
/** Every accepted `secretManager` value. */
export declare const SECRET_MANAGERS: readonly SecretManager[];
/** Attributes this plugin stores and looks up its key under in the GNOME keyring. */
export declare const DEFAULT_GNOME_KEYRING_ATTRIBUTES: Readonly<Record<string, string>>;
/** Entry path this plugin looks its key up under in `pass`. */
export declare const DEFAULT_PASS_PATH = "dsh/brave-search-api";
/** How long one lookup may take before the chain moves on. */
export declare const SECRET_LOOKUP_TIMEOUT_MS = 5000;
/** Longest tool output accepted. */
export declare const MAX_SECRET_OUTPUT_BYTES = 65536;
/** Most attribute pairs passed to one lookup. */
export declare const MAX_SECRET_ARGUMENTS = 16;
/** The GNOME keyring command. */
export declare const GNOME_SECRET_TOOL = "secret-tool";
/** The standard Unix password manager command. */
export declare const PASS_TOOL = "pass";

/** A lookup that produced no value, with a secret-free note for each source tried. */
export interface SecretLookupMiss {
    readonly value?: undefined;
    readonly source?: undefined;
    /** Plain-language notes, one per attempted source. */
    readonly attempted: readonly string[];
}
/** A lookup that produced a value. */
export interface SecretLookupHit {
    /** The secret value. */
    readonly value: string;
    /** Which store supplied it: `gnome-keyring` or `pass`. */
    readonly source: string;
    /** Notes for any source consulted before this one. */
    readonly attempted: readonly string[];
}
/** The outcome of one lookup or one chain of lookups. */
export type SecretLookupResult = SecretLookupHit | SecretLookupMiss;

/** The injectable command runner; injected by tests so no real tool is spawned. */
export type SecretExecFile = (file: string, args: readonly string[], options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}) => Promise<{
    stdout: string;
    stderr: string;
}>;

/** Options accepted by one lookup. */
export interface SecretLookupOptions {
    /** Command runner; defaults to {@link execFileAsync}. */
    execFile?: SecretExecFile;
    /** Per-command timeout; defaults to {@link SECRET_LOOKUP_TIMEOUT_MS}. */
    timeoutMs?: number;
    /** Cancels the lookup, killing the child process. */
    signal?: AbortSignal;
}

/** The first non-blank line of a command's output, trimmed. */
export declare function firstLine(text: unknown): string | undefined;
/** Sanitize configured keyring attributes into `<name> <value>` argument pairs. */
export declare function secretAttributes(attributes: unknown): [string, string][];
/** Run one command with no shell, a bounded runtime, and a bounded output size. */
export declare function execFileAsync(file: string, args: readonly string[], options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<{
    stdout: string;
    stderr: string;
}>;
/** Read the key from the GNOME keyring. */
export declare function lookupGnomeKeyring(attributes: unknown, options?: SecretLookupOptions): Promise<SecretLookupResult>;
/** Read the key from `pass`. */
export declare function lookupPass(path: unknown, options?: SecretLookupOptions): Promise<SecretLookupResult>;
/** Work through the configured secret managers in order. */
export declare function resolveSecret(options?: {
    manager?: string;
    gnomeKeyringAttributes?: unknown;
    passPath?: unknown;
} & SecretLookupOptions): Promise<SecretLookupResult>;
