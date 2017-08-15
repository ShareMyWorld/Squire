/*jshint strict:false, undef:false, unused:false */

var keys = {
    8: 'backspace',
    9: 'tab',
    13: 'enter',
    32: 'space',
    33: 'pageup',
    34: 'pagedown',
    37: 'left',
    39: 'right',
    46: 'delete',
    219: '[',
    221: ']'
};

// Ref: http://unixpapa.com/js/key.html
var onKey = function ( event ) {
    var code = event.keyCode,
        key = keys[ code ],
        modifiers = '',
        range = this.getSelection();

    if ( event.defaultPrevented ) {
        return;
    }

    if (this._blockKeyEvents) {
        event.preventDefault();
        return;
    }

    if ( !key ) {
        key = String.fromCharCode( code ).toLowerCase();
        // Only reliable for letters and numbers
        if ( !/^[A-Za-z0-9]$/.test( key ) ) {
            key = '';
        }
    }

    // On keypress, delete and '.' both have event.keyCode 46
    // Must check event.which to differentiate.
    if ( isPresto && event.which === 46 ) {
        key = '.';
    }

    // Function keys
    if ( 111 < code && code < 124 ) {
        key = 'f' + ( code - 111 );
    }

    // We need to apply the backspace/delete handlers regardless of
    // control key modifiers.
    if ( key !== 'backspace' && key !== 'delete' ) {
        if ( event.altKey  ) { modifiers += 'alt-'; }
        if ( event.ctrlKey ) { modifiers += 'ctrl-'; }
        if ( event.metaKey ) { modifiers += 'meta-'; }
        if ( event.shiftKey ) { modifiers += 'shift-'; }
    }
    // However, on Windows, shift-delete is apparently "cut" (WTF right?), so
    // we want to let the browser handle shift-delete.
    //if ( event.shiftKey ) { modifiers += 'shift-'; }
    var keyWithModifiers = modifiers + key;

    if (this._undoIndex === -1) {
        this.saveUndoState( range );
        this._isInUndoState = false
    }

    if ( this._keyHandlers[ keyWithModifiers ] ) {
        this._keyHandlers[keyWithModifiers](this, event, range);
    } else if (!event.ctrlKey && !event.metaKey && isRangeSelectingWidget(this._root, range)) {
        event.preventDefault();
    } else if (!range.collapsed) {
        // Android
        var widgetNode = findNodeInRange(range, function(node) {
             return isWidget(node);
        });
        var self = this;

        if (widgetNode && !event.metaKey && ((event.ctrlKey && event.altKey) || (!event.ctrlKey && !event.altKey))) {
            self.saveUndoState(range);
        }

        if (keyWithModifiers.length === 1 ) {
            replaceRangeWithInput(self, range);
        }

        //
        // if (widgetNode) {
        //     event.preventDefault();
        //     this._blockKeyEvents = true;
        //     this.confirmDeleteWidget(widgetNode.getAttribute('widget-id'), widgetNode.getAttribute('widget-type')).then(function() {
        //         replaceRangeWithInput(self, range)
        //     }).finally(function() {
        //         self._blockKeyEvents = false;
        //         self.focus();
        //     });
        // } else {
        // replaceRangeWithInput(self, range);
        // }
    }
};

function isRangeSelectingWidget(root, range) {
    if (!range.startContainer || !range.endContainer) {
        return false;
    }
    var start = range.startContainer.nodeType === 1 ? range.startContainer.childNodes[range.startOffset] : range.startContainer;
    var end;
    if (range.endOffset === 0) {
        end = range.endContainer;
    } else {
        end = range.endContainer.nodeType === 1 ? range.endContainer.childNodes[range.endOffset - 1] : range.endContainer;
    }


    return getNearestCallback(start, root, isWidget) && getNearestCallback(end, root, isWidget);
}

function replaceRangeWithInput(self, range) {
    // Record undo checkpoint.
    self.saveUndoState( range );
    // Delete the selection
    deleteContentsOfRange( range, self._root );
    self._ensureBottomLine();
    self.setSelection( range );
    self._updatePath( range, true );
}

var mapKeyTo = function ( method ) {
    return function ( self, event ) {
        event.preventDefault();
        self[ method ]();
    };
};

var mapKeyToFormat = function ( tag, remove ) {
    remove = remove || null;
    return function ( self, event ) {
        event.preventDefault();
        var range = self.getSelection();
        if ( self.hasFormat( tag, null, range ) ) {
            self.changeFormat( null, { tag: tag }, range );
        } else {
            self.changeFormat( { tag: tag }, remove, range );
        }
    };
};

// If you delete the content inside a span with a font styling, Webkit will
// replace it with a <font> tag (!). If you delete all the text inside a
// link in Opera, it won't delete the link. Let's make things consistent. If
// you delete all text inside an inline tag, remove the inline tag.
var afterDelete = function ( self, range ) {
    try {
        if ( !range ) { range = self.getSelection(); }
        var node = range.startContainer,
            parent;
        // Climb the tree from the focus point while we are inside an empty
        // inline element
        if ( node.nodeType === TEXT_NODE ) {
            node = node.parentNode;
        }
        parent = node;
        while ( isInline( parent ) &&
                ( !parent.textContent || parent.textContent === ZWS ) ) {
            node = parent;
            parent = node.parentNode;
        }
        // If focussed in empty inline element
        if ( node !== parent ) {
            // Move focus to just before empty inline(s)
            range.setStart( parent,
                indexOf.call( parent.childNodes, node ) );
            range.collapse( true );
            // Remove empty inline(s)
            parent.removeChild( node );
            // Fix cursor in block
            if ( !isBlock( parent ) ) {
                parent = getPreviousBlock( parent, self._root );
            }
            fixCursor( parent, self._root );
            // Move cursor into text node
            moveRangeBoundariesDownTree( range );
        }
        if (isBlock(parent)) {
            if (parent.nodeName !== self._config.blockTag) {
                fixContainer(self._root, self._root);
                moveRangeBoundariesDownTree( range );
            } else {
                mergeInlines( parent, range );
            }
        }
        // If you delete the last character in the sole <div> in Chrome,
        // it removes the div and replaces it with just a <br> inside the
        // root. Detach the <br>; the _ensureBottomLine call will insert a new
        // block.
        if ( node === self._root &&
                ( node = node.firstChild ) && node.nodeName === 'BR' ) {
            detach( node );
        }
        self._ensureBottomLine();
        self.setSelection( range );
        self._updatePath( range, true );
    } catch ( error ) {
        self.didError( error );
    }
};

var keyHandlers = {
    'shift-enter': function ( self, event, range) {
        if (!canInsertLineBreak(self, range)) {
            event.preventDefault();
        }
    },
    enter: function ( self, event, range ) {
        var root = self._root;

        // We handle this ourselves
        event.preventDefault();

        // Save undo checkpoint and add any links in the preceding section.
        // Remove any zws so we don't think there's content in an empty
        // block.
        self._recordUndoState( range );
        addLinks( range.startContainer );
        self._removeZWS();
        self._getRangeAndRemoveBookmark( range );

        // Selected text is overwritten, therefore delete the contents
        // to collapse selection.
        if ( !range.collapsed ) {
            deleteContentsOfRange( range, root );
        }

        fixContainer(root, root);

        var current = getStartBlockOfRange( range, root );

        if (!current) {
            range.collapse( false );
            self.setSelection( range );
            self._updatePath( range, true );
            return;
        }

        var currentBlock = current.parentNode;
        var currentContainer, nodeAfterSplit, blockAfterSplit;
        
        if (currentBlock === root || isAside(currentBlock)) {
            currentContainer = currentBlock;
            currentBlock = current;
        } else {
            currentContainer = currentBlock.parentNode;
        }

        if (self._inlineMode) {
            var br = createElement( self._doc, 'br' );
            insertNodeInRange(range, br);
            range.setStartAfter(br);
            range.setEndAfter(br);
        } else {
            // We need a reference to the link so we can figure out which of the two to keep after split
            var linkBeforeSplit = getNearest(range.startContainer, root, 'A');

            if ( isHeading(currentBlock) ) {
                if (!current.textContent.trim()) {
                    // Empty headings becomes P instead
                    currentContainer.insertBefore( self.createDefaultBlock(), currentBlock );
                    detach( currentBlock );
                    nodeAfterSplit = splitBlock( self, current, range.startContainer, range.startOffset );
                } else  {
                    if (range.startOffset === 0) {
                        currentContainer.insertBefore( self.createDefaultBlock(), currentBlock );
                        nodeAfterSplit = current;
                    } else {
                        nodeAfterSplit = splitBlockAndUnwrapAfter( self, currentBlock, range );
                    }
                }

            } else if (isBlockquote(currentBlock)) {
                nodeAfterSplit = splitBlockAndUnwrapAfter( self, currentBlock, range );

            } else if (isListItem(currentBlock)) {
                if (currentContainer.lastElementChild === currentBlock && !current.textContent.trim()) {
                    self.modifyBlocks( decreaseListLevel, range );
                    nodeAfterSplit = current;
                } else {
                    blockAfterSplit = splitBlock( self, currentBlock, range.startContainer, range.startOffset );
                    nodeAfterSplit = blockAfterSplit.firstElementChild;
                }
            } else {
                nodeAfterSplit = splitBlock( self, current, range.startContainer, range.startOffset );
            }

            // Ensure the P before split is still focusable
            removeZWS( current );
            removeEmptyInlines( current );
            fixCursor( current, root );

            // Focus cursor
            // If there's a <b>/<i> etc. at the beginning of the split
            // make sure we focus inside it.
            while ( nodeAfterSplit.nodeType === ELEMENT_NODE ) {
                var child = nodeAfterSplit.firstChild,
                    next;

                // Don't continue links over a block break; unlikely to be the
                // desired outcome.
                if ( nodeAfterSplit.nodeName === 'A') {
                    var nodeTextContent = nodeAfterSplit.textContent;
                    if (nodeTextContent === ZWS) {
                        nodeTextContent = '';
                    }
                    if ( !nodeTextContent || ( linkBeforeSplit && linkBeforeSplit.textContent && linkBeforeSplit.href === nodeAfterSplit.href )) {
                        child = self._doc.createTextNode(nodeTextContent);
                        replaceWith( nodeAfterSplit, child );
                        nodeAfterSplit = child;
                        break;
                    } else if ( linkBeforeSplit && !linkBeforeSplit.textContent ) {
                        detach( linkBeforeSplit );
                        linkBeforeSplit = null;
                    }
                }

                while ( child && child.nodeType === TEXT_NODE && !child.data ) {
                    next = child.nextSibling;
                    detach( child );
                    child = next;
                }

                if ( child && child.nodeName === 'BR') {
                    // Remove BR in the beginning of the splitted node, they are confusing after pressing return just before a br
                    next = child.nextSibling;
                    detach( child );
                    child = next;
                }

                // 'BR's essentially don't count; they're a browser hack.
                // If you try to select the contents of a 'BR', FF will not let
                // you type anything!
                if ( !child || ( child.nodeType === TEXT_NODE && !isPresto ) ) {
                    break;
                }

                nodeAfterSplit = child;
            }
        }

        if (nodeAfterSplit) {
            range = self._createRange( nodeAfterSplit, 0 );
        }
        fixContainer(root, root);
        self.setSelection( range );
        self._updatePath( range, true );
    },
    backspace: function ( self, event, range ) {
        var root = self._root;
        self._removeZWS();
        // Record undo checkpoint.
        self.saveUndoState( range );
        // If not collapsed, delete contents
        if ( !range.collapsed ) {
            event.preventDefault();
            deleteContentsOfRange( range, root );
            afterDelete( self, range );
        } else {
            
            var start = range.startContainer;
            if (start.nodeType === ELEMENT_NODE && start.firstChild && !isInline(start)) {
                // Try diving down until we find a block
                if (range.startOffset >= start.childNodes.length) {
                    if (start.lastChild.nodeType === ELEMENT_NODE) {
                        range.setStart(start.lastChild, start.lastChild.childNodes.length);
                        range.setEnd(start.lastChild, start.lastChild.childNodes.length);
                    } else {
                        range.setStart(start.lastChild, start.lastChild.data.length);
                        range.setEnd(start.lastChild, start.lastChild.data.length);
                    }
                } else {
                    moveRangeBoundariesDownTree(range);
                }
            }

            // If at beginning of block, merge with previous
            if ( rangeDoesStartAtBlockBoundary( range, root ) ) {
                event.preventDefault();
                var current = getStartBlockOfRange( range, root ),
                    previous;
                if ( !current ) {
                    return;
                }
                // In case inline data has somehow got between blocks.
                fixContainer( current.parentNode, root );
                // Now get previous block (p tag)
                previous = getPreviousBlock( current, root );

                var currentBlock = current.parentNode;
                var currentContainer;
                if (currentBlock === root || isAside(currentBlock)) {
                    currentContainer = currentBlock;
                    currentBlock = current;
                } else {
                    currentContainer = currentBlock.parentNode;
                }

                // Replace the blockquote with a p, i.e. unset blockquote
                if (isBlockquote(currentBlock)) {
                    self.modifyBlocks( decreaseBlockQuoteLevel, range );
                }
                // If the block is the first block within the container, or if the previous sibling is a container
                else if ( currentContainer.firstElementChild === currentBlock || isAside(currentBlock.previousElementSibling)) {
                    if (isListItem(currentBlock)) {
                        self.modifyBlocks(decreaseListLevel, range);
                    }
                }
                else if ( previous ) {
                    // The rest of the actions we need to merge with previous node or delete previous node

                    var previousBlock;
                    if (previous.parentNode === root || isAside(previous.parentNode)) {
                        previousBlock = previous;
                    } else {
                        previousBlock = previous.parentNode;
                    }

                    if ( isWidget(previousBlock) ) {
                        self._blockKeyEvents = true;
                        self.confirmDeleteWidget(previousBlock.getAttribute('widget-id'), previousBlock.getAttribute('widget-type')).then(function() {
                            detach( previousBlock );
                        }).finally(function() {
                            self._blockKeyEvents = false;
                            self.focus();
                        });
                    }
                    else if ( isPagebreak(previousBlock) || ((isParagraph(previousBlock) || isHeading(previousBlock)) && !previous.textContent.trim()) || !previousBlock.isContentEditable) {
                        // We prefer removing previous block in this case to keep header formatting for currentBlock example
                        detach( previousBlock );
                    }
                    else {
                        mergeWithBlock( previous, current, range );
                    }
                }
                fixContainer( root, root );
                self.setSelection( range );
                self._updatePath( range, true );

            }
            // Otherwise, leave to browser but check afterwards whether it has
            // left behind an empty inline tag.
            else {
                self.setSelection( range );
                setTimeout( function () { afterDelete( self ); }, 0 );
            }
        }
    },
    'delete': function ( self, event, range ) {
        var root = self._root;
        var current, next, originalRange,
            cursorContainer, cursorOffset, nodeAfterCursor;
        self._removeZWS();
        // Record undo checkpoint.
        self.saveUndoState( range );
        // If not collapsed, delete contents
        if ( !range.collapsed ) {
            event.preventDefault();
            deleteContentsOfRange( range, root );
            afterDelete( self, range );
        }
        // If at end of block, merge next into this block
        else if ( rangeDoesEndAtBlockBoundary( range, root ) ) {
            event.preventDefault();
            current = getStartBlockOfRange( range, root );
            if ( !current ) {
                return;
            }
            // In case inline data has somehow got between blocks.
            fixContainer( current.parentNode, root );
            // Now get next block
            next = getNextBlock( current, root );
            
            var currentBlock, currentContainer;
            if (current.parentNode === root || isAside(current.parentNode)) {
                currentBlock = current;
                currentContainer = current.parentNode;
            } else {
                currentBlock = current.parentNode;
                currentContainer = currentBlock.parentNode;
            }

            if ( isAside(currentBlock.nextElementSibling ) ||
                    ( currentContainer.lastElementChild === currentBlock && ( !isList(currentContainer) || isAside(currentContainer.nextElementSibling)) )) {
                // Do not merge if last element of container
            } else if ( next ) {
                var nextBlock;
                if (next.parentNode === root || isAside(next.parentNode)) {
                    nextBlock = next;
                } else {
                    nextBlock = next.parentNode;
                }

                if ( isWidget(nextBlock) ) {
                    self._blockKeyEvents = true;
                    self.confirmDeleteWidget(nextBlock.getAttribute('widget-id'), nextBlock.getAttribute('widget-type')).then(function() {
                        detach( nextBlock );
                    }).finally(function() {
                        self._blockKeyEvents = false;
                        self.focus();
                    });
                }
                else if ( isPagebreak(nextBlock) || !nextBlock.isContentEditable) {
                    detach( nextBlock );
                }
                else if ( isParagraph( currentBlock ) && !current.textContent.trim() ) {
                    detach( currentBlock );
                    range.setStart( next, 0 );
                    moveRangeBoundariesDownTree(range);
                }
                else {
                    mergeWithBlock( current, next, range );
                }

                fixContainer( root, root );
                self.setSelection( range );
                self._updatePath( range, true );
            }
        }
        // Otherwise, leave to browser but check afterwards whether it has
        // left behind an empty inline tag.
        else {
            // But first check if the cursor is just before an IMG tag. If so,
            // delete it ourselves, because the browser won't if it is not
            // inline.
            originalRange = range.cloneRange();
            moveRangeBoundariesUpTree( range, self._root );
            cursorContainer = range.endContainer;
            cursorOffset = range.endOffset;
            if ( cursorContainer.nodeType === ELEMENT_NODE ) {
                nodeAfterCursor = cursorContainer.childNodes[ cursorOffset ];
                if ( nodeAfterCursor && nodeAfterCursor.nodeName === 'IMG' ) {
                    event.preventDefault();
                    detach( nodeAfterCursor );
                    moveRangeBoundariesDownTree( range );
                    afterDelete( self, range );
                    return;
                }
            }
            self.setSelection( originalRange );
            setTimeout( function () { afterDelete( self ); }, 0 );
        }
    },
    /*
    tab: function ( self, event, range ) {
        var root = self._root;
        var node, parent;
        self._removeZWS();
        // If no selection and at start of block
        if ( range.collapsed && rangeDoesStartAtBlockBoundary( range, root ) ) {
            node = getStartBlockOfRange( range, root );
            // Iterate through the block's parents
            while ( parent = node.parentNode ) {
                // If we find a UL or OL (so are in a list, node must be an LI)
                if ( parent.nodeName === 'UL' || parent.nodeName === 'OL' ) {
                    // AND the LI is not the first in the list
                    if ( node.previousSibling ) {
                        // Then increase the list level
                        event.preventDefault();
                        self.modifyBlocks( increaseListLevel, range );
                    }
                    break;
                }
                node = parent;
            }
        }
    },
    'shift-tab': function ( self, event, range ) {
        var root = self._root;
        var node;
        self._removeZWS();
        // If no selection and at start of block
        if ( range.collapsed && rangeDoesStartAtBlockBoundary( range, root ) ) {
            // Break list
            node = range.startContainer;
            if ( getNearest( node, root, 'UL' ) ||
                    getNearest( node, root, 'OL' ) ) {
                event.preventDefault();
                self.modifyBlocks( decreaseListLevel, range );
            }
        }
    },
    */
    space: function ( self, _, range ) {
        var node, parent;
        self._recordUndoState( range );
        addLinks( range.startContainer );
        self._getRangeAndRemoveBookmark( range );

        // If the cursor is at the end of a link (<a>foo|</a>) then move it
        // outside of the link (<a>foo</a>|) so that the space is not part of
        // the link text.
        node = range.endContainer;
        parent = node.parentNode;
        if ( range.collapsed && parent.nodeName === 'A' &&
                !node.nextSibling && range.endOffset === getLength( node ) ) {
            range.setStartAfter( parent );
        }

        self.setSelection( range );
    },
    left: function ( self ) {
        self._removeZWS();
    },
    right: function ( self ) {
        self._removeZWS();
    }
};


// Firefox pre v29 incorrectly handles Cmd-left/Cmd-right on Mac:
// it goes back/forward in history! Override to do the right
// thing.
// https://bugzilla.mozilla.org/show_bug.cgi?id=289384
if ( isMac && isGecko ) {
    keyHandlers[ 'meta-left' ] = function ( self, event ) {
        event.preventDefault();
        var sel = getWindowSelection( self );
        if ( sel && sel.modify ) {
            sel.modify( 'move', 'backward', 'lineboundary' );
        }
    };
    keyHandlers[ 'meta-right' ] = function ( self, event ) {
        event.preventDefault();
        var sel = getWindowSelection( self );
        if ( sel && sel.modify ) {
            sel.modify( 'move', 'forward', 'lineboundary' );
        }
    };
}

// System standard for page up/down on Mac is to just scroll, not move the
// cursor. On Linux/Windows, it should move the cursor, but some browsers don't
// implement this natively. Override to support it.
if ( !isMac ) {
    keyHandlers.pageup = function ( self ) {
        self.moveCursorToStart();
    };
    keyHandlers.pagedown = function ( self ) {
        self.moveCursorToEnd();
    };
}

/*keyHandlers[ ctrlKey + 'b' ] = mapKeyToFormat( 'B' );
keyHandlers[ ctrlKey + 'i' ] = mapKeyToFormat( 'I' );
keyHandlers[ ctrlKey + 'u' ] = mapKeyToFormat( 'U' );
keyHandlers[ ctrlKey + 'shift-7' ] = mapKeyToFormat( 'S' );
keyHandlers[ ctrlKey + 'shift-5' ] = mapKeyToFormat( 'SUB', { tag: 'SUP' } );
keyHandlers[ ctrlKey + 'shift-6' ] = mapKeyToFormat( 'SUP', { tag: 'SUB' } );
keyHandlers[ ctrlKey + 'shift-8' ] = mapKeyTo( 'makeUnorderedList' );
keyHandlers[ ctrlKey + 'shift-9' ] = mapKeyTo( 'makeOrderedList' );
keyHandlers[ ctrlKey + '[' ] = mapKeyTo( 'decreaseQuoteLevel' );
keyHandlers[ ctrlKey + ']' ] = mapKeyTo( 'increaseQuoteLevel' );
keyHandlers[ ctrlKey + 'y' ] = mapKeyTo( 'redo' );
keyHandlers[ ctrlKey + 'z' ] = mapKeyTo( 'undo' );
keyHandlers[ ctrlKey + 'shift-z' ] = mapKeyTo( 'redo' );*/
