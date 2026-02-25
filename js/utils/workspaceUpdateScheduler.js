// Copyright (c) 2024 Sugar Labs Contributors
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the The GNU Affero General Public
// License as published by the Free Software Foundation; either
// version 3 of the License, or (at your option) any later version.
//
// You should have received a copy of the GNU Affero General Public
// License along with this library; if not, write to the Free Software
// Foundation, 51 Franklin Street, Suite 500 Boston, MA 02110-1335 USA

/* exported WorkspaceUpdateScheduler */

/**
 * WorkspaceUpdateScheduler — Virtual-DOM-Lite / Throttled Workspace Update
 * -------------------------------------------------------------------------
 * Eliminates "Paint Storms" and "Layout Thrashing" caused by per-block
 * container.updateCache() + stage.update() calls firing in rapid succession
 * (e.g. during unhighlightAll(), or when multiple setTimeout-scheduled
 * unhighlight callbacks fire within the same animation frame for concurrent
 * turtles in a large project).
 *
 * Root causes addressed
 * ---------------------
 * 1. PAINT STORM — blocks.unhighlightAll() previously called
 *    container.updateCache() once per block in a tight loop, potentially
 *    triggering N individual EaselJS cache re-renders before any of them
 *    were composited to the screen.
 *
 * 2. UNCOORDINATED STAGE UPDATES — each setTimeout unhighlight callback
 *    (one per playing note block) called activity.stage.update() independently,
 *    meaning the browser could receive dozens of full-canvas repaints per
 *    animation frame during polyphonic playback.
 *
 * 3. GPU LAYER PROMOTION — the EaselJS stage canvas is a single raster
 *    surface.  Animating it without a compositor hint forces the browser to
 *    re-rasterise the entire canvas on the CPU on every frame.  Adding
 *    will-change: transform while updates are pending promotes the canvas
 *    to a dedicated GPU compositor layer, so subsequent stage.update() calls
 *    trigger only a texture upload + compositing step instead of a full
 *    CPU repaint of the workspace.
 *
 * How it works
 * ------------
 * Callers replace direct container.updateCache() / stage.update() calls with:
 *
 *   scheduler.scheduleBlockUpdate(block);   // register dirty block
 *   scheduler.scheduleStageUpdate();         // request stage flush
 *
 * All registered work is flushed together inside a single
 * requestAnimationFrame callback, guaranteeing:
 *   - container.updateCache() is invoked exactly once per dirty block per frame
 *   - stage.update()          is invoked exactly once per frame
 *   - will-change: transform  is applied to the stage canvas only while work
 *                             is pending and cleared immediately after flush
 *
 * Usage
 * -----
 *   // Instantiate once on the Blocks object (activity.blocks.blockUpdateScheduler)
 *   const scheduler = new WorkspaceUpdateScheduler(activity);
 *
 *   // In block highlight / unhighlight:
 *   scheduler.scheduleBlockUpdate(this);   // `this` is a Block instance
 *
 *   // After coordinating state changes:
 *   scheduler.scheduleStageUpdate();
 *
 *   // On activity teardown:
 *   scheduler.cancel();
 */
class WorkspaceUpdateScheduler {
    /**
     * @param {object} activity - The Music Blocks activity object (exposes .stage).
     */
    constructor(activity) {
        this._activity = activity;

        /** @type {Set<object>} Block instances whose containers need updateCache(). */
        this._pendingBlocks = new Set();

        /** @type {number|null} Active requestAnimationFrame handle. */
        this._rafHandle = null;

        /** True when at least one caller requested stage.update() this frame. */
        this._stageUpdatePending = false;
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Enqueue a Block instance so its container.updateCache() is called during
     * the next animation frame flush.  Calling this multiple times within the
     * same synchronous execution path for the same block is safe — the internal
     * Set deduplicates entries.
     *
     * @param {object} block - A Block instance (must have .container with
     *                         an EaselJS-compatible updateCache() method).
     */
    scheduleBlockUpdate(block) {
        if (!block || !block.container) {
            return;
        }

        this._pendingBlocks.add(block);
        this._applyWillChange();
        this._requestFlush();
    }

    /**
     * Request that stage.update() is called during the next animation frame
     * flush.  Multiple concurrent callers collapse into a single deferred call.
     */
    scheduleStageUpdate() {
        this._stageUpdatePending = true;
        this._applyWillChange();
        this._requestFlush();
    }

    /**
     * Cancel any pending flush and discard all queued work.
     * Must be called during activity teardown to prevent stale RAF callbacks.
     */
    cancel() {
        if (this._rafHandle !== null) {
            cancelAnimationFrame(this._rafHandle);
            this._rafHandle = null;
        }

        this._pendingBlocks.clear();
        this._stageUpdatePending = false;
        this._removeWillChange();
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /** Promote the stage canvas to a GPU compositor layer while work is queued. */
    _applyWillChange() {
        const canvas = this._getStageCanvas();
        if (canvas && canvas.style && canvas.style.willChange !== "transform") {
            canvas.style.willChange = "transform";
        }
    }

    /** Remove the compositor hint once the frame has been painted. */
    _removeWillChange() {
        const canvas = this._getStageCanvas();
        if (canvas && canvas.style) {
            canvas.style.willChange = "auto";
        }
    }

    /** @returns {HTMLCanvasElement|null} */
    _getStageCanvas() {
        return this._activity && this._activity.stage ? this._activity.stage.canvas : null;
    }

    /** Schedule an RAF flush if one is not already pending. */
    _requestFlush() {
        if (this._rafHandle === null) {
            this._rafHandle = requestAnimationFrame(() => this._flush());
        }
    }

    /**
     * Flush all pending work in a single animation frame:
     *   1. Call container.updateCache() for every dirty block (deduped by Set).
     *   2. Call stage.update() once if any caller requested it.
     *   3. Remove the will-change hint so idle blocks don't waste GPU memory.
     */
    _flush() {
        this._rafHandle = null;

        // --- Phase 1: batch all dirty-block cache updates ---
        for (const block of this._pendingBlocks) {
            if (block.container) {
                block.container.updateCache();
            }
        }
        this._pendingBlocks.clear();

        // --- Phase 2: single stage composite ---
        if (this._stageUpdatePending) {
            this._stageUpdatePending = false;
            if (this._activity && this._activity.stage) {
                this._activity.stage.update();
            }
        }

        // --- Phase 3: release GPU layer hint ---
        this._removeWillChange();
    }
}

/* Make WorkspaceUpdateScheduler available as a RequireJS-shimmed global. */
window.WorkspaceUpdateScheduler = WorkspaceUpdateScheduler;
