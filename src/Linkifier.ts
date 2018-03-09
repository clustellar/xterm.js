/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IMouseZoneManager } from './input/Types';
import { ILinkHoverEvent, ILinkMatcher, LinkMatcherHandler, LinkHoverEventTypes, ILinkMatcherOptions, IBufferAccessor, ILinkifier, IElementAccessor } from './Types';
import { MouseZone } from './input/MouseZoneManager';
import { EventEmitter } from './EventEmitter';

/**
 * The Linkifier applies links to rows shortly after they have been refreshed.
 */
export class Linkifier extends EventEmitter implements ILinkifier {
  /**
   * The time to wait after a row is changed before it is linkified. This prevents
   * the costly operation of searching every row multiple times, potentially a
   * huge amount of times.
   */
  protected static TIME_BEFORE_LINKIFY = 200;

  protected _linkMatchers: ILinkMatcher[] = [];

  private _mouseZoneManager: IMouseZoneManager;
  private _rowsTimeoutId: number;
  private _nextLinkMatcherId = 0;
  private _rowsToLinkify: {start: number, end: number};

  constructor(
    protected _terminal: IBufferAccessor & IElementAccessor
  ) {
    super();
    this._rowsToLinkify = {
      start: null,
      end: null
    };
  }

  /**
   * Attaches the linkifier to the DOM, enabling linkification.
   * @param mouseZoneManager The mouse zone manager to register link zones with.
   */
  public attachToDom(mouseZoneManager: IMouseZoneManager): void {
    this._mouseZoneManager = mouseZoneManager;
  }

  /**
   * Queue linkification on a set of rows.
   * @param start The row to linkify from (inclusive).
   * @param end The row to linkify to (inclusive).
   */
  public linkifyRows(start: number, end: number): void {
    // Don't attempt linkify if not yet attached to DOM
    if (!this._mouseZoneManager) {
      return;
    }

    // Increase range to linkify
    if (this._rowsToLinkify.start === null) {
      this._rowsToLinkify.start = start;
      this._rowsToLinkify.end = end;
    } else {
      this._rowsToLinkify.start = Math.min(this._rowsToLinkify.start, start);
      this._rowsToLinkify.end = Math.max(this._rowsToLinkify.end, end);
    }

    // Clear out any existing links on this row range
    this._mouseZoneManager.clearAll(start, end);

    // Restart timer
    if (this._rowsTimeoutId) {
      clearTimeout(this._rowsTimeoutId);
    }
    this._rowsTimeoutId = <number><any>setTimeout(() => this._linkifyRows(), Linkifier.TIME_BEFORE_LINKIFY);
  }

  /**
   * Linkifies the rows requested.
   */
  private _linkifyRows(): void {
    this._rowsTimeoutId = null;
    for (let i = this._rowsToLinkify.start; i <= this._rowsToLinkify.end; i++) {
      this._linkifyRow(i);
    }
    this._rowsToLinkify.start = null;
    this._rowsToLinkify.end = null;
  }

  /**
   * Registers a link matcher, allowing custom link patterns to be matched and
   * handled.
   * @param regex The regular expression to search for. Specifically, this
   * searches the textContent of the rows. You will want to use \s to match a
   * space ' ' character for example.
   * @param handler The callback when the link is called.
   * @param options Options for the link matcher.
   * @return The ID of the new matcher, this can be used to deregister.
   */
  public registerLinkMatcher(regex: RegExp, handler: LinkMatcherHandler, options: ILinkMatcherOptions = {}): number {
    if (!handler) {
      throw new Error('handler must be defined');
    }
    const matcher: ILinkMatcher = {
      id: this._nextLinkMatcherId++,
      regex,
      handler,
      matchIndex: options.matchIndex,
      validationCallback: options.validationCallback,
      hoverTooltipCallback: options.tooltipCallback,
      hoverLeaveCallback: options.leaveCallback,
      willLinkActivate: options.willLinkActivate,
      priority: options.priority || 0
    };
    this._addLinkMatcherToList(matcher);
    return matcher.id;
  }

  /**
   * Inserts a link matcher to the list in the correct position based on the
   * priority of each link matcher. New link matchers of equal priority are
   * considered after older link matchers.
   * @param matcher The link matcher to be added.
   */
  private _addLinkMatcherToList(matcher: ILinkMatcher): void {
    if (this._linkMatchers.length === 0) {
      this._linkMatchers.push(matcher);
      return;
    }

    for (let i = this._linkMatchers.length - 1; i >= 0; i--) {
      if (matcher.priority <= this._linkMatchers[i].priority) {
        this._linkMatchers.splice(i + 1, 0, matcher);
        return;
      }
    }

    this._linkMatchers.splice(0, 0, matcher);
  }

  /**
   * Deregisters a link matcher if it has been registered.
   * @param matcherId The link matcher's ID (returned after register)
   * @return Whether a link matcher was found and deregistered.
   */
  public deregisterLinkMatcher(matcherId: number): boolean {
    for (let i = 0; i < this._linkMatchers.length; i++) {
      if (this._linkMatchers[i].id === matcherId) {
        this._linkMatchers.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  /**
   * Linkifies a row.
   * @param rowIndex The index of the row to linkify.
   */
  private _linkifyRow(rowIndex: number): void {
    const absoluteRowIndex = this._terminal.buffer.ydisp + rowIndex;
    if (absoluteRowIndex >= this._terminal.buffer.lines.length) {
      return;
    }
    const text = this._terminal.buffer.translateBufferLineToString(absoluteRowIndex, false);
    for (let i = 0; i < this._linkMatchers.length; i++) {
      this._doLinkifyRow(rowIndex, text, this._linkMatchers[i]);
    }
  }

  /**
   * Linkifies a row given a specific handler.
   * @param rowIndex The row index to linkify.
   * @param text The text of the row (excludes text in the row that's already
   * linkified).
   * @param matcher The link matcher for this line.
   * @param offset The how much of the row has already been linkified.
   * @return The link element(s) that were added.
   */
  private _doLinkifyRow(rowIndex: number, text: string, matcher: ILinkMatcher, offset: number = 0): void {
    // Find the first match
    let match = text.match(matcher.regex);
    if (!match || match.length === 0) {
      return;
    }
    let uri = match[typeof matcher.matchIndex !== 'number' ? 0 : matcher.matchIndex];

    // Get index, match.index is for the outer match which includes negated chars
    const index = text.indexOf(uri);

    // Ensure the link is valid before registering
    if (matcher.validationCallback) {
      matcher.validationCallback(uri, isValid => {
        // Discard link if the line has already changed
        if (this._rowsTimeoutId) {
          return;
        }
        if (isValid) {
          this._addLink(offset + index, rowIndex, uri, matcher);
        }
      });
    } else {
      this._addLink(offset + index, rowIndex, uri, matcher);
    }

    // Recursively check for links in the rest of the text
    const remainingStartIndex = index + uri.length;
    const remainingText = text.substr(remainingStartIndex);
    if (remainingText.length > 0) {
      this._doLinkifyRow(rowIndex, remainingText, matcher, offset + remainingStartIndex);
    }
  }

  /**
   * Registers a link to the mouse zone manager.
   * @param x The column the link starts.
   * @param y The row the link is on.
   * @param uri The URI of the link.
   * @param matcher The link matcher for the link.
   */
  private _addLink(x: number, y: number, uri: string, matcher: ILinkMatcher): void {
    this._mouseZoneManager.add(new MouseZone(
      x + 1,
      x + 1 + uri.length,
      y + 1,
      e => {
        if (matcher.handler) {
          return matcher.handler(e, uri);
        }
        window.open(uri, '_blank');
      },
      e => {
        this.emit(LinkHoverEventTypes.HOVER, <ILinkHoverEvent>{ x, y, length: uri.length});
        this._terminal.element.style.cursor = 'pointer';
      },
      e => {
        this.emit(LinkHoverEventTypes.TOOLTIP, <ILinkHoverEvent>{ x, y, length: uri.length});
        if (matcher.hoverTooltipCallback) {
          matcher.hoverTooltipCallback(e, uri);
        }
      },
      () => {
        this.emit(LinkHoverEventTypes.LEAVE, <ILinkHoverEvent>{ x, y, length: uri.length});
        this._terminal.element.style.cursor = '';
        if (matcher.hoverLeaveCallback) {
          matcher.hoverLeaveCallback();
        }
      },
      e => {
        if (matcher.willLinkActivate) {
          return matcher.willLinkActivate(e, uri);
        }
        return true;
      }
    ));
  }
}
