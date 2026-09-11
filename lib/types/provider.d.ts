// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Chuck <chuck@actvite.com>
/**
 * The Brave-backed search provider registered with `ctx.web`.
 * @module dsh-web-search-brave/provider
 */
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web';
import type { BraveSearchProviderOptions } from './config.js';
import type { BraveTransportDependencies } from './client.js';
import type { SecretExecFile } from './secrets.js';

/** The seams a provider may be handed in place of real transport and tool runners. */
export interface BraveProviderDependencies extends BraveTransportDependencies {
    /** Replaces the secret-manager command runner. */
    execFile?: SecretExecFile;
}

/** Whether a fully resolved option set is usable. Local, cheap, and credential-free. */
export declare function optionsAreUsable(options: BraveSearchProviderOptions): boolean;
/** The Brave-backed search provider. */
export declare class BraveSearchProvider implements WebSearchProvider {
    /** Stable id this provider registers under: `brave-official`. */
    readonly id: string;
    /**
     * @param resolveOptions - the options for the NEXT operation, snapshotted once at each operation's entry; it receives the provider's own deps so injected seams reach option resolution.
     * @param deps - optional transport and tool-runner seams, used by tests.
     */
    constructor(resolveOptions: (deps?: BraveProviderDependencies) => BraveSearchProviderOptions, deps?: BraveProviderDependencies);
    /** Cheap local usability check; never makes a network call and never throws. */
    available(): boolean;
    /** Run one search. */
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
}
