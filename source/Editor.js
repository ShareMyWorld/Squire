/*jshint strict:false, undef:false, unused:false */

var instances = [];

function getSquireInstance ( doc ) {
    var l = instances.length,
        instance;
    while ( l-- ) {
        instance = instances[l];
        if ( instance._doc === doc ) {
            return instance;
        }
    }
    return null;
}

function mergeObjects ( base, extras ) {
    var prop, value;
    if ( !base ) {
        base = {};
    }
    for ( prop in extras ) {
        value = extras[ prop ];
        base[ prop ] = ( value && value.constructor === Object ) ?
            mergeObjects( base[ prop ], value ) :
            value;
    }
    return base;
}

function Squire ( root, config ) {
    if ( root.nodeType === DOCUMENT_NODE ) {
        root = root.body;
    }
    var doc = root.ownerDocument;
    var win = doc.defaultView;
    var mutation;

    this._win = win;
    this._doc = doc;
    this._root = root;

    this._events = {};

    this._lastSelection = null;

    // IE loses selection state of iframe on blur, so make sure we
    // cache it just before it loses focus.
    if ( losesSelectionOnBlur ) {
        this.addEventListener( 'beforedeactivate', this.getSelection );
    }

    this._hasZWS = false;

    this._lastAnchorNode = null;
    this._lastFocusNode = null;
    this._path = '';

    this.addEventListener( 'keyup', this._updatePathOnEvent );
    this.addEventListener( 'mouseup', this._updatePathOnEvent );
    this.addEventListener( 'undoStateChange', this._updateUndoState );

    this._undoIndex = -1;
    this._undoStack = [];
    this._undoScrollTopStack = [];
    this._undoStackLength = 0;
    this._isInUndoState = false;
    this._ignoreChange = false;

    this._canUndo = false;
    this._canRedo = false;

    if ( canObserveMutations ) {
        mutation = new MutationObserver( this._docWasChanged.bind( this ) );
        mutation.observe( root, {
            childList: true,
            attributes: true,
            characterData: true,
            subtree: true
        });
        this._mutation = mutation;
    } else {
        this.addEventListener( 'keyup', this._keyUpDetectChange );
    }

    // On blur, restore focus except if there is any change to the content, or
    // the user taps or clicks to focus a specific point. Can't actually use
    // click event because focus happens before click, so use
    // mousedown/touchstart
    this._restoreSelection = false;
    this.addEventListener( 'blur', enableRestoreSelection );
    this.addEventListener( 'input', disableRestoreSelection );
    this.addEventListener( 'mousedown', disableRestoreSelection );
    this.addEventListener( 'touchstart', disableRestoreSelection );
    this.addEventListener( 'focus', restoreSelection );
    this._onSelectionChange = onSelectionChange.bind( this );
    doc.addEventListener( 'selectionchange', this._onSelectionChange, true );

    if (isIOS) {
        this._onVisibilityChange = onVisibilityChange.bind(this);
        doc.addEventListener('visibilitychange', this._onVisibilityChange, true);
    }

    // IE sometimes fires the beforepaste event twice; make sure it is not run
    // again before our after paste function is called.
    this._awaitingPaste = false;
    this.addEventListener( isIElt11 ? 'beforecut' : 'cut', onCut );
    this._onCut = onCut.bind(this);
    this.addEventListener( 'copy', onCopy );
    this.addEventListener( isIElt11 ? 'beforepaste' : 'paste', onPaste );

    // Opera does not fire keydown repeatedly.
    this.addEventListener( isPresto ? 'keypress' : 'keydown', onKey );

    // Add key handlers
    this._keyHandlers = Object.create( keyHandlers );
    
    // Used to block all keyevents when showing confirm dialogs
    this._blockKeyEvents = false;

    // Override default properties
    this.setConfig( config );

    //SMW
    this._allowedContent = 
       createAllowedContentMap( config.classifications, config.allowedTags );

    this._classifications = config.classifications;
    this._allowedBlocks = config.allowedBlocksForContainers;
    
    this._allowedBlocksForContainers = config.allowedBlocksForContainers;
    this._allowedInlineContentForBlocks = config.allowedInlineContentForBlocks;
    
    this._translateToSmw = 
        createTranslationMap( config.tagAttributes, config.allowedTags );

    this._validTags = Object.keys( this._translateToSmw );

    this._onPasteErrorCallback = config.onPasteErrorCallback;
    this._onPasteCallback = config.onPasteCallback;
    this._inlineMode =  config.inlineMode;

    this.confirmDeleteWidget = config.confirmDeleteWidget;

    // Fix IE<10's buggy implementation of Text#splitText.
    // If the split is at the end of the node, it doesn't insert the newly split
    // node into the document, and sets its value to undefined rather than ''.
    // And even if the split is not at the end, the original node is removed
    // from the document and replaced by another, rather than just having its
    // data shortened.
    // We used to feature test for this, but then found the feature test would
    // sometimes pass, but later on the buggy behaviour would still appear.
    // I think IE10 does not have the same bug, but it doesn't hurt to replace
    // its native fn too and then we don't need yet another UA category.
    if ( isIElt11 ) {
        win.Text.prototype.splitText = function ( offset ) {
            var afterSplit = this.ownerDocument.createTextNode(
                    this.data.slice( offset ) ),
                next = this.nextSibling,
                parent = this.parentNode,
                toDelete = this.length - offset;
            if ( next ) {
                parent.insertBefore( afterSplit, next );
            } else {
                parent.appendChild( afterSplit );
            }
            if ( toDelete ) {
                this.deleteData( offset, toDelete );
            }
            return afterSplit;
        };
    }

    root.setAttribute( 'contenteditable', 'true' );

    // Remove Firefox's built-in controls
    try {
        doc.execCommand( 'enableObjectResizing', false, 'false' );
        doc.execCommand( 'enableInlineTableEditing', false, 'false' );
    } catch ( error ) {}

    instances.push( this );

    // Need to register instance before calling setHTML, so that the fixCursor
    // function can lookup any default block tag options set.
    this.setHTML( config.html || '', false, true );
}

var proto = Squire.prototype;

proto.setConfig = function ( config ) {
    config = mergeObjects({
        blockTag: 'DIV',
        blockAttributes: null,
        tagAttributes: {
            blockquote: null,
            ul: null,
            ol: null,
            li: null,
        }
    }, config );

    // Users may specify block tag in lower case
    config.blockTag = config.blockTag.toUpperCase();

    this._config = config;

    return this;
};

proto.createElement = function ( tag, props, children ) {
    return createElement( this._doc, tag, props, children );
};

proto.createDefaultBlock = function ( children, node ) {
    var config = this._config;
    return fixCursor(
        this.createElement( config.blockTag, config.blockAttributes, children ),
        this._root
    );
};

proto.didError = function ( error ) {
    console.error( error );
};

proto.getDocument = function () {
    return this._doc;
};
proto.getRoot = function () {
    return this._root;
};

// --- Events ---

// Subscribing to these events won't automatically add a listener to the
// document node, since these events are fired in a custom manner by the
// editor code.
var customEvents = {
    pathChange: 1, select: 1, input: 1, undoStateChange: 1,
    dragover: 1, drop: 1
};

proto.fireEvent = function ( type, event ) {
    var handlers = this._events[ type ],
        l, obj;
    if ( handlers ) {
        if ( !event ) {
            event = {};
        }
        if ( event.type !== type ) {
            event.type = type;
        }
        // Clone handlers array, so any handlers added/removed do not affect it.
        handlers = handlers.slice();
        while (handlers.length > 0 ) {
            obj = handlers.shift();
            try {
                if ( obj.handleEvent ) {
                    obj.handleEvent( event );
                } else {
                    obj.call( this, event );
                }
            } catch ( error ) {
                error.details = 'Squire: fireEvent error. Event type: ' + type;
                this.didError( error );
            }
        }
    }
    return this;
};

proto.destroy = function () {
    var root = this._root,
        events = this._events,
        type;
    for ( type in events ) {
        if ( !customEvents[ type ] ) {
            root.removeEventListener( type, this, true );
        }
    }
    if ( this._mutation ) {
        this._mutation.disconnect();
    }
    this._doc.removeEventListener( 'selectionchange', this._onSelectionChange, true );

    if (isIOS) {
        this._doc.removeEventListener('visibilitychange', this._onVisibilityChange, true);
    }
    var l = instances.length;
    while ( l-- ) {
        if ( instances[l] === this ) {
            instances.splice( l, 1 );
        }
    }

    // Destroy undo stack
    this._undoIndex = -1;
    this._undoStack = [];
    this._undoStackLength = 0;
};

proto.handleEvent = function ( event ) {
    this.fireEvent( event.type, event );
};

proto.addEventListener = function ( type, fn ) {
    var handlers = this._events[ type ];
    if ( !fn ) {
        this.didError({
            name: 'Squire: addEventListener with null or undefined fn',
            message: 'Event type: ' + type
        });
        return this;
    }
    if ( !handlers ) {
        handlers = this._events[ type ] = [];
        if ( !customEvents[ type ] ) {
            this._root.addEventListener( type, this, true );
        }
    }
    handlers.push( fn );
    return this;
};

proto.removeEventListener = function ( type, fn ) {
    var handlers = this._events[ type ],
        l;
    if ( handlers ) {
        l = handlers.length;
        while ( l-- ) {
            if ( handlers[l] === fn ) {
                handlers.splice( l, 1 );
            }
        }
        if ( !handlers.length ) {
            delete this._events[ type ];
            if ( !customEvents[ type ] ) {
                this._root.removeEventListener( type, this, true );
            }
        }
    }
    return this;
};

// --- Selection and Path ---

proto._createRange =
        function ( range, startOffset, endContainer, endOffset ) {
    if ( range instanceof this._win.Range ) {
        return range.cloneRange();
    }
    var domRange = this._doc.createRange();
    domRange.setStart( range, startOffset );
    if ( endContainer ) {
        domRange.setEnd( endContainer, endOffset );
    } else {
        domRange.setEnd( range, startOffset );
    }
    return domRange;
};

proto.getCursorPosition = function ( range ) {
    if ( ( !range && !( range = this.getSelection() ) ) ||
            !range.getBoundingClientRect ) {
        return null;
    }
    // Get the bounding rect
    var rect = range.getBoundingClientRect();
    var node, parent;
    if ( rect && !rect.top ) {
        this._ignoreChange = true;
        node = this._doc.createElement( 'SPAN' );
        node.textContent = ZWS;
        insertNodeInRange( range, node );
        rect = node.getBoundingClientRect();
        parent = node.parentNode;
        parent.removeChild( node );
        _mergeInlines( parent, {
            startContainer: range.startContainer,
            endContainer: range.endContainer,
            startOffset: range.startOffset,
            endOffset: range.endOffset
        });
    }
    return rect;
};

proto._moveCursorTo = function ( toStart ) {
    var root = this._root,
        range = this._createRange( root, toStart ? 0 : root.childNodes.length );
    moveRangeBoundariesDownTree( range );
    this.setSelection( range );
    return this;
};
proto.moveCursorToStart = function () {
    return this._moveCursorTo( true );
};
proto.moveCursorToEnd = function () {
    return this._moveCursorTo( false );
};

var getWindowSelection = function ( self ) {
    return self._win.getSelection() || null;
};

proto.setSelection = function ( range ) {
    if ( range ) {
        // If we're setting selection, that automatically, and synchronously, // triggers a focus event. Don't want a reentrant call to setSelection.
        this._restoreSelection = false;
        this._lastSelection = range;
        // iOS bug: if you don't focus the iframe before setting the
        // selection, you can end up in a state where you type but the input
        // doesn't get directed into the contenteditable area but is instead
        // lost in a black hole. Very strange.
        if ( isIOS ) {
            this._win.focus();
        }
        var sel = getWindowSelection( this );
        if ( sel ) {
            sel.removeAllRanges();
            sel.addRange( range );
        }
    }
    return this;
};

proto.getSelection = function () {
    var sel = getWindowSelection( this );
    var root = this._root;
    var selection, startContainer, endContainer;
    if ( sel && sel.rangeCount ) {
        selection  = sel.getRangeAt( 0 ).cloneRange();
        startContainer = selection.startContainer;
        endContainer = selection.endContainer;
        // FF can return the selection as being inside an <img>. WTF?
        if ( startContainer && isLeaf( startContainer ) ) {
            selection.setStartBefore( startContainer );
        }
        if ( endContainer && isLeaf( endContainer ) ) {
            selection.setEndBefore( endContainer );
        }
    }
    if ( selection &&
            isOrContains( root, selection.commonAncestorContainer ) ) {
        this._lastSelection = selection;
    } else {
        selection = this._lastSelection;
    }
    if ( !selection ) {
        selection = this._createRange( root.firstChild, 0 );
    }
    return selection;
};

function enableRestoreSelection () {
    this._restoreSelection = true;
}
function disableRestoreSelection () {
    this._restoreSelection = false;
}
function restoreSelection () {
    if ( this._restoreSelection ) {
        this.setSelection( this._lastSelection );
    }
}

proto.getSelectedText = function () {
    var range = this.getSelection(),
        walker = new TreeWalker(
            range.commonAncestorContainer,
            SHOW_TEXT|SHOW_ELEMENT,
            function ( node ) {
                return isNodeContainedInRange( range, node, true );
            }
        ),
        startContainer = range.startContainer,
        endContainer = range.endContainer,
        node = walker.currentNode = startContainer,
        textContent = '',
        addedTextInBlock = false,
        value;

    if ( !walker.filter( node ) ) {
        node = walker.nextNode();
    }

    while ( node ) {
        if ( node.nodeType === TEXT_NODE ) {
            value = node.data;
            if ( value && ( /\S/.test( value ) ) ) {
                if ( node === endContainer ) {
                    value = value.slice( 0, range.endOffset );
                }
                if ( node === startContainer ) {
                    value = value.slice( range.startOffset );
                }
                textContent += value;
                addedTextInBlock = true;
            }
        } else if ( node.nodeName === 'BR' ||
                addedTextInBlock && !isInline( node ) ) {
            textContent += '\n';
            addedTextInBlock = false;
        } else if ( node.nodeName === 'HR' ||
                addedTextInBlock && !isInline( node ) ) {
            textContent += '\n\n\n';
            addedTextInBlock = false;
        }
        node = walker.nextNode();
    }

    return textContent;
};

proto.getPath = function () {
    return this._path;
};

// --- Workaround for browsers that can't focus empty text nodes ---

// WebKit bug: https://bugs.webkit.org/show_bug.cgi?id=15256

var removeZWS = function ( root ) {
    var walker = new TreeWalker( root, SHOW_TEXT, function () {
            return true;
        }, false ),
        parent, node, index;
    while ( node = walker.nextNode() ) {
        if ( node.data ) {
            while ( ( index = node.data.indexOf( ZWS ) ) > -1 ) {
            if ( node.length === 1 ) {
                do {
                    parent = node.parentNode;
                    parent.removeChild( node );
                    node = parent;
                    walker.currentNode = parent;
                } while ( isInline( node ) && !getLength( node ) );
                break;
            } else {
                node.deleteData( index, 1 );
            }
        }
        }

    }
};

proto._didAddZWS = function () {
    this._hasZWS = true;
};
proto._removeZWS = function () {
    if ( !this._hasZWS ) {
        return;
    }
    removeZWS( this._root );
    this._hasZWS = false;
};

// --- Path change events ---

proto._updatePath = function ( range, force ) {
    if ( !range ) {
        return;
    }
    var anchor = range.startContainer,
        focus = range.endContainer,
        newPath;
    if ( force || anchor !== this._lastAnchorNode ||
            focus !== this._lastFocusNode ) {
        this._lastAnchorNode = anchor;
        this._lastFocusNode = focus;
        newPath = ( anchor && focus ) ? ( anchor === focus ) ?
            getPath( focus, this._root ) : '(selection)' : '';
        if ( this._path !== newPath ) {
            this._path = newPath;
            this.fireEvent( 'pathChange', { path: newPath } );
        }
    }
    if ( !range.collapsed ) {
        this.fireEvent( 'select' );
    }
};

proto._updatePathOnEvent = function () {
    this._updatePath( this.getSelection() );
};

proto._updateUndoState = function ( obj ) {
    this._canUndo = obj.canUndo;
    this._canRedo = obj.canRedo;
};

// --- Focus ---

proto.focus = function () {
    this._root.focus();
    return this;
};

proto.blur = function () {
    this._root.blur();
    return this;
};

// --- Bookmarking ---

var startSelectionId = 'squire-selection-start';
var endSelectionId = 'squire-selection-end';

proto._saveRangeToBookmark = function ( range ) {
    var startNode = this.createElement( 'INPUT', {
            id: startSelectionId,
            type: 'hidden'
        }),
        endNode = this.createElement( 'INPUT', {
            id: endSelectionId,
            type: 'hidden'
        }),
        temp;

    insertNodeInRange( range, startNode );
    range.collapse( false );
    insertNodeInRange( range, endNode );

    // In a collapsed range, the start is sometimes inserted after the end!
    if ( startNode.compareDocumentPosition( endNode ) &
            DOCUMENT_POSITION_PRECEDING ) {
        startNode.id = endSelectionId;
        endNode.id = startSelectionId;
        temp = startNode;
        startNode = endNode;
        endNode = temp;
    }

    range.setStartAfter( startNode );
    range.setEndBefore( endNode );
};

proto._getRangeAndRemoveBookmark = function ( range ) {
    var root = this._root,
        start = root.querySelector( '#' + startSelectionId ),
        end = root.querySelector( '#' + endSelectionId );

    if ( start && end ) {
        var startContainer = start.parentNode,
            endContainer = end.parentNode;

        var _range = {
            startContainer: startContainer,
            endContainer: endContainer,
            startOffset: indexOf.call( startContainer.childNodes, start ),
            endOffset: indexOf.call( endContainer.childNodes, end )
        };

        if ( startContainer === endContainer ) {
            _range.endOffset -= 1;
        }

        detach( start );
        detach( end );

        if ( !range ) {
            range = this._doc.createRange();
        }
        range.setStart( _range.startContainer, _range.startOffset );
        range.setEnd( _range.endContainer, _range.endOffset );

        // Merge any text nodes we split
        mergeInlines( startContainer, range );
        if ( startContainer !== endContainer ) {
            mergeInlines( endContainer, range );
        }

        // If we didn't split a text node, we should move into any adjacent
        // text node to current selection point
        if ( range.collapsed ) {
            startContainer = range.startContainer;
            if ( startContainer.nodeType === TEXT_NODE ) {
                endContainer = startContainer.childNodes[ range.startOffset ];
                if ( !endContainer || endContainer.nodeType !== TEXT_NODE ) {
                    endContainer =
                        startContainer.childNodes[ range.startOffset - 1 ];
                }
                if ( endContainer && endContainer.nodeType === TEXT_NODE ) {
                    range.setStart( endContainer, 0 );
                    range.collapse( true );
                }
            }
        }
    }
    return range || null;
};

// --- Undo ---

proto._keyUpDetectChange = function ( event ) {
    var code = event.keyCode;
    // Presume document was changed if:
    // 1. A modifier key (other than shift) wasn't held down
    // 2. The key pressed is not in range 16<=x<=20 (control keys)
    // 3. The key pressed is not in range 33<=x<=45 (navigation keys)
    if ( !event.metaKey && ((!event.altKey && !event.ctrlKey) || (event.altKey && event.ctrlKey)) &&
            ( code < 16 || code > 20 ) &&
            ( code < 33 || code > 45 ) ) {
        this._docWasChanged();
    }
};

proto._docWasChanged = function () {
    if ( canObserveMutations && this._ignoreChange ) {
        this._ignoreChange = false;
        return;
    }
    if ( this._isInUndoState ) {
        this._isInUndoState = false;
        this.fireEvent( 'undoStateChange', {
            canUndo: true,
            canRedo: false
        });
    }
    if (this._undoIndex === -1) {
        this.saveUndoState();
        this._isInUndoState = false;
    }
    this.fireEvent( 'input' );
};

// Leaves bookmark
proto._recordUndoState = function ( range, replace ) {
    // Don't record if we're already in an undo state
    if ( !this._isInUndoState || replace) {
        // Advance pointer to new position
        var undoIndex = this._undoIndex += 1,
            undoStack = this._undoStack,
            undoScrollTopStack = this._undoScrollTopStack;

        // Truncate stack if longer (i.e. if has been previously undone)
        if ( undoIndex < this._undoStackLength ) {
            undoStack.length = this._undoStackLength = undoIndex;
            undoScrollTopStack.length = this._undoStackLength = undoIndex;
        }

        // Ensure we save a fully functional html
        fixContainer(this._root, this._root);
        // Write out data
        if ( range ) {
            this._saveRangeToBookmark( range );
        }
        undoStack[ undoIndex ] = this._getHTML();
        if (undoIndex === 0) {
            undoScrollTopStack[ undoIndex ] = null;
        } else {
            undoScrollTopStack[ undoIndex ] = this._doc.documentElement.scrollTop || this._doc.body.scrollTop;
        }
        this._undoStackLength += 1;
        this._isInUndoState = true;
        this.fireEvent( 'undoStateChange', {
            canUndo: this._undoIndex > 0,
            canRedo: false
        });
    }
};

proto.saveUndoState = function ( range ) {
    if ( range === undefined ) {
        range = this.getSelection();
    }
    if ( !this._isInUndoState ) {
        this._recordUndoState( range, this._isInUndoState );
        this._getRangeAndRemoveBookmark( range );
    }
    return this;
};

proto.undo = function () {
    // Sanity check: must not be at beginning of the history stack
    if ( this._undoIndex > 0 || (!this._isInUndoState && this._undoIndex >= 0) ) {
        // Make sure any changes since last checkpoint are saved.
        this._recordUndoState( this.getSelection() );

        this._undoIndex -= 1;
        var scrollTop = this._undoScrollTopStack[ this._undoIndex ];
        if (scrollTop === null) {
            scrollTop = this._doc.documentElement.scrollTop || this._doc.body.scrollTop;
        }
        this._setHTML( this._undoStack[ this._undoIndex ] );

        var range = this._getRangeAndRemoveBookmark();
        if ( range ) {
            this.setSelection( range );
        }
        this._isInUndoState = true;
        this.fireEvent( 'undoStateChange', {
            canUndo: this._undoIndex > 0,
            canRedo: true
        });
        this.fireEvent( 'input' );
        this._doc.documentElement.scrollTop = scrollTop;
        this._doc.body.scrollTop = scrollTop;
        var self = this;
        setTimeout(function() {
            if (self._doc && self._doc.documentElement) {
                self._doc.documentElement.scrollTop = scrollTop;
                self._doc.body.scrollTop = scrollTop;
            }
        }, 16);
    }
    return this.focus();
};

proto.redo = function () {
    // Sanity check: must not be at end of stack and must be in an undo
    // state.
    var undoIndex = this._undoIndex,
        undoStackLength = this._undoStackLength;
    if ( undoIndex + 1 < undoStackLength && this._isInUndoState ) {
        this._undoIndex += 1;
        var scrollTop = this._undoScrollTopStack[ this._undoIndex ];
        this._setHTML( this._undoStack[ this._undoIndex ] );
        var range = this._getRangeAndRemoveBookmark();
        if ( range ) {
            this.setSelection( range );
        }
        this.fireEvent( 'undoStateChange', {
            canUndo: true,
            canRedo: undoIndex + 2 < undoStackLength
        });
        this.fireEvent( 'input' );
        this._doc.documentElement.scrollTop = scrollTop;
        this._doc.body.scrollTop = scrollTop;
        var self = this;
        setTimeout(function() {
            if (self._doc && self._doc.documentElement) {
                self._doc.documentElement.scrollTop = scrollTop;
                self._doc.body.scrollTop = scrollTop;
            }
        }, 16);
    }
    return this.focus();
};

// --- Inline formatting ---

// Looks for matching tag and attributes, so won't work
// if <strong> instead of <b> etc.
proto.hasFormat = function ( tag, attributes, range ) {
    // 1. Normalise the arguments and get selection
    tag = tag.toUpperCase();
    if ( !attributes ) { attributes = {}; }
    if ( !range && !( range = this.getSelection() ) ) {
        return false;
    }

    // Sanitize range to prevent weird IE artifacts
    if ( !range.collapsed &&
            range.startContainer.nodeType === TEXT_NODE &&
            range.startOffset === range.startContainer.length &&
            range.startContainer.nextSibling ) {
        range.setStartBefore( range.startContainer.nextSibling );
    }
    if ( !range.collapsed &&
            range.endContainer.nodeType === TEXT_NODE &&
            range.endOffset === 0 &&
            range.endContainer.previousSibling ) {
        range.setEndAfter( range.endContainer.previousSibling );
    }

    // If the common ancestor is inside the tag we require, we definitely
    // have the format.
    var root = this._root;
    var common = range.commonAncestorContainer;
    var walker, node;
    if ( getNearest( common, root, tag, attributes ) ) {
        return true;
    }

    // If common ancestor is a text node and doesn't have the format, we
    // definitely don't have it.
    if ( common.nodeType === TEXT_NODE ) {
        return false;
    }

    // Otherwise, check each text node at least partially contained within
    // the selection and make sure all of them have the format we want.
    walker = new TreeWalker( common, SHOW_TEXT, function ( node ) {
        return isNodeContainedInRange( range, node, true );
    }, false );

    var seenNode = false;
    while ( node = walker.nextNode() ) {
        if ( !getNearest( node, root, tag, attributes ) ) {
            return false;
        }
        seenNode = true;
    }

    return seenNode;
};



// Extracts the font-family and font-size (if any) of the element
// holding the cursor. If there's a selection, returns an empty object.
proto.getFontInfo = function ( range ) {
    var fontInfo = {
        color: undefined,
        backgroundColor: undefined,
        family: undefined,
        size: undefined
    };
    var seenAttributes = 0;
    var element, style, attr;

    if ( !range && !( range = this.getSelection() ) ) {
        return fontInfo;
    }

    element = range.commonAncestorContainer;
    if ( range.collapsed || element.nodeType === TEXT_NODE ) {
        if ( element.nodeType === TEXT_NODE ) {
            element = element.parentNode;
        }
        while ( seenAttributes < 4 && element ) {
            if ( style = element.style ) {
                if ( !fontInfo.color && ( attr = style.color ) ) {
                    fontInfo.color = attr;
                    seenAttributes += 1;
                }
                if ( !fontInfo.backgroundColor &&
                        ( attr = style.backgroundColor ) ) {
                    fontInfo.backgroundColor = attr;
                    seenAttributes += 1;
                }
                if ( !fontInfo.family && ( attr = style.fontFamily ) ) {
                    fontInfo.family = attr;
                    seenAttributes += 1;
                }
                if ( !fontInfo.size && ( attr = style.fontSize ) ) {
                    fontInfo.size = attr;
                    seenAttributes += 1;
                }
            }
            element = element.parentNode;
        }
    }
    return fontInfo;
};

proto._addFormat = function ( tag, attributes, range ) {
    // If the range is collapsed we simply insert the node by wrapping
    // it round the range and focus it.
    var root = this._root;
    var el, walker, startContainer, endContainer, startOffset, endOffset,
        node, needsFormat;

    if ( range.collapsed ) {
        el = fixCursor( this.createElement( tag, attributes ), root );
        insertNodeInRange( range, el );
        range.setStart( el.firstChild, el.firstChild.length );
        range.collapse( true );
    }
    // Otherwise we find all the textnodes in the range (splitting
    // partially selected nodes) and if they're not already formatted
    // correctly we wrap them in the appropriate tag.
    else {
        // Create an iterator to walk over all the text nodes under this
        // ancestor which are in the range and not already formatted
        // correctly.
        //
        // In Blink/WebKit, empty blocks may have no text nodes, just a <br>.
        // Therefore we wrap this in the tag as well, as this will then cause it
        // to apply when the user types something in the block, which is
        // presumably what was intended.
        //
        // IMG tags are included because we may want to create a link around them,
        // and adding other styles is harmless.
        walker = new TreeWalker(
            range.commonAncestorContainer,
            SHOW_TEXT|SHOW_ELEMENT,
            function ( node ) {
                return ( node.nodeType === TEXT_NODE ||
                        node.nodeName === 'BR' ||
                        node.nodeName === 'IMG'
                    ) && isNodeContainedInRange( range, node, true );
            },
            false
        );

        // Start at the beginning node of the range and iterate through
        // all the nodes in the range that need formatting.
        startContainer = range.startContainer;
        startOffset = range.startOffset;
        endContainer = range.endContainer;
        endOffset = range.endOffset;

        // Make sure we start with a valid node.
        walker.currentNode = startContainer;
        if ( !walker.filter( startContainer ) ) {
            startContainer = walker.nextNode();
            startOffset = 0;
        }

        // If there are no interesting nodes in the selection, abort
        if ( !startContainer ) {
            return range;
        }

        do {
            node = walker.currentNode;
            needsFormat = !getNearest( node, root, tag, attributes );
            if ( needsFormat ) {
                // <br> can never be a container node, so must have a text node
                // if node == (end|start)Container
                if ( node === endContainer && node.length > endOffset ) {
                    node.splitText( endOffset );
                }
                if ( node === startContainer && startOffset ) {
                    node = node.splitText( startOffset );
                    if ( endContainer === startContainer ) {
                        endContainer = node;
                        endOffset -= startOffset;
                    }
                    startContainer = node;
                    startOffset = 0;
                }
                el = this.createElement( tag, attributes );
                replaceWith( node, el );
                el.appendChild( node );
            }
        } while ( walker.nextNode() );

        // If we don't finish inside a text node, offset may have changed.
        if ( endContainer.nodeType !== TEXT_NODE ) {
            if ( node.nodeType === TEXT_NODE ) {
                endContainer = node;
                endOffset = node.length;
            } else {
                // If <br>, we must have just wrapped it, so it must have only
                // one child
                endContainer = node.parentNode;
                endOffset = 1;
            }
        }

        // Now set the selection to as it was before
        range = this._createRange(
            startContainer, startOffset, endContainer, endOffset );
    }
    return range;
};

proto._removeFormat = function ( tag, attributes, range, partial ) {
    // Add bookmark
    this._saveRangeToBookmark( range );

    // We need a node in the selection to break the surrounding
    // formatted text.
    var doc = this._doc,
        fixer;
    if ( range.collapsed ) {
        if ( cantFocusEmptyTextNodes ) {
            fixer = doc.createTextNode( ZWS );
            this._didAddZWS();
        } else {
            fixer = doc.createTextNode( '' );
        }
        insertNodeInRange( range, fixer );
    }

    // Find block-level ancestor of selection
    var root = range.commonAncestorContainer;
    while ( isInline( root ) ) {
        root = root.parentNode;
    }

    // Find text nodes inside formatTags that are not in selection and
    // add an extra tag with the same formatting.
    var startContainer = range.startContainer,
        startOffset = range.startOffset,
        endContainer = range.endContainer,
        endOffset = range.endOffset,
        toWrap = [],
        examineNode = function ( node, exemplar ) {
            // If the node is completely contained by the range then
            // we're going to remove all formatting so ignore it.
            if ( isNodeContainedInRange( range, node, false ) ) {
                return;
            }

            var isText = ( node.nodeType === TEXT_NODE ),
                child, next;

            // If not at least partially contained, wrap entire contents
            // in a clone of the tag we're removing and we're done.
            if ( !isNodeContainedInRange( range, node, true ) ) {
                // Ignore bookmarks and empty text nodes
                if ( node.nodeName !== 'INPUT' &&
                        ( !isText || node.data ) ) {
                    toWrap.push([ exemplar, node ]);
                }
                return;
            }

            // Split any partially selected text nodes.
            if ( isText ) {
                if ( node === endContainer && endOffset !== node.length ) {
                    toWrap.push([ exemplar, node.splitText( endOffset ) ]);
                }
                if ( node === startContainer && startOffset ) {
                    node.splitText( startOffset );
                    toWrap.push([ exemplar, node ]);
                }
            }
            // If not a text node, recurse onto all children.
            // Beware, the tree may be rewritten with each call
            // to examineNode, hence find the next sibling first.
            else {
                for ( child = node.firstChild; child; child = next ) {
                    next = child.nextSibling;
                    examineNode( child, exemplar );
                }
            }
        },
        formatTags = Array.prototype.filter.call(
            root.getElementsByTagName( tag ), function ( el ) {
                return isNodeContainedInRange( range, el, true ) &&
                    hasTagAttributes( el, tag, attributes );
            }
        );

    if ( !partial ) {
        formatTags.forEach( function ( node ) {
            examineNode( node, node );
        });
    }

    // Now wrap unselected nodes in the tag
    toWrap.forEach( function ( item ) {
        // [ exemplar, node ] tuple
        var el = item[0].cloneNode( false ),
            node = item[1];
        replaceWith( node, el );
        el.appendChild( node );
    });
    // and remove old formatting tags.
    formatTags.forEach( function ( el ) {
        replaceWith( el, empty( el ) );
    });

    // Merge adjacent inlines:
    this._getRangeAndRemoveBookmark( range );
    if ( fixer ) {
        range.collapse( false );
    }
    var _range = {
        startContainer: range.startContainer,
        startOffset: range.startOffset,
        endContainer: range.endContainer,
        endOffset: range.endOffset
    };
    _mergeInlines( root, _range );
    range.setStart( _range.startContainer, _range.startOffset );
    range.setEnd( _range.endContainer, _range.endOffset );

    return range;
};

proto.changeFormat = function ( add, remove, range, partial ) {
    // Normalise the arguments and get selection
    if ( !range && !( range = this.getSelection() ) ) {
        return;
    }

    // Save undo checkpoint
    this.saveUndoState( range );

    if ( remove ) {
        range = this._removeFormat( remove.tag.toUpperCase(),
            remove.attributes || {}, range, partial );
    }
    if ( add ) {
        range = this._addFormat( add.tag.toUpperCase(),
            add.attributes || {}, range );
    }

    this.setSelection( range );
    this._updatePath( range, true );

    // We're not still in an undo state
    if ( !canObserveMutations ) {
        this._docWasChanged();
    }

    return this;
};

// --- Block formatting ---

var tagAfterSplit = {
    DT:  'DD',
    DD:  'DT',
    LI:  'LI'
};

var splitBlock = function ( self, block, node, offset ) {
    var splitTag = tagAfterSplit[ block.nodeName ],
        splitProperties = null,
        nodeAfterSplit = split( node, offset, block.parentNode, self._root ),
        config = self._config;

    if ( !splitTag ) {
        splitTag = config.blockTag;
        splitProperties = config.blockAttributes;    
    }

    // Make sure the new node is the correct type.
    if ( !hasTagAttributes( nodeAfterSplit, splitTag, splitProperties ) ) {
        block = createElement( nodeAfterSplit.ownerDocument,
            splitTag, splitProperties );
        if ( nodeAfterSplit.dir ) {
            block.dir = nodeAfterSplit.dir;
        }
        replaceWith( nodeAfterSplit, block );
        block.appendChild( empty( nodeAfterSplit ) );
        nodeAfterSplit = block;
    }
    return nodeAfterSplit;
};

var splitBlockAndUnwrapAfter = function( self, block, range ) {
    var blockAfterSplit = splitBlock( self, block, range.startContainer, range.startOffset);
    var nodeAfterSplit = blockAfterSplit.firstElementChild;
    var container = block.parentNode;
    // Remove Heading in the new block
    container.insertBefore(nodeAfterSplit, blockAfterSplit);
    container.removeChild(blockAfterSplit);

    return nodeAfterSplit;
}

proto.forEachBlock = function ( fn, mutates, range ) {
    if ( !range && !( range = this.getSelection() ) ) {
        return this;
    }

    // Save undo checkpoint
    if ( mutates ) {
        this.saveUndoState( range );
    }

    var root = this._root;
    var start = getStartBlockOfRange( range, root );
    var end = getEndBlockOfRange( range, root );
    if ( start && end ) {
        do {
            if ( fn( start ) || start === end ) { break; }
        } while ( start = getNextBlock( start, root ) );
    }

    if ( mutates ) {
        this.setSelection( range );

        // Path may have changed
        this._updatePath( range, true );

        // We're not still in an undo state
        if ( !canObserveMutations ) {
            this._docWasChanged();
        }
    }
    return this;
};

/**
 *
 * @param {function} modify - Callback function that will be called with a document fragment containing the nodes that should be modified
 * @param {Range=} range - The range to where to apply the modify operation. Defaults to current selection.
 * @param {String=} expandToPattern - A Regexp string identifying the tag name of parent block the range should try to expand to
 * @param {Object} expandToAttrs - Extra attributes that must also match for expandToPattern to match the node.
 * @param {Boolean=} forceModifyFromRoot - If set to true, the document fragment will be relative to root instead of nearest block container.
 * @param {Range} selectionRange - Alternate range to use for selection
 * @returns {Squire} 
 */
proto.modifyBlocks = function ( modify, range, expandToPattern, expandToAttrs, forceModifyFromRoot, selectionRange ) {
    if ( !range && !( range = this.getSelection() ) ) {
        return this;
    }

    // 1. Save undo checkpoint and bookmark selection
    if ( this._isInUndoState ) {
        this._saveRangeToBookmark( selectionRange || range );
    } else {
        this._recordUndoState( selectionRange || range );
    }

    var root = this._root;
    var frag, blockContainer, expandContainer;

    // 2. Expand range to block boundaries
    if (expandToPattern) {
        expandContainer = getNearestLike(range.commonAncestorContainer, expandToPattern, expandToAttrs);
    }
    if (expandContainer) {
        range.setStart(expandContainer, 0);
        range.setEnd(expandContainer, expandContainer.childNodes.length);
    } else {
        expandRangeToBlockBoundaries( range, root );
    }

    // 3. Remove range.
    if (forceModifyFromRoot) {
        blockContainer = root;
    } else {
        // Get Neareast parent container that can contain other blocks
        blockContainer = getNearest(range.commonAncestorContainer, root, 'BLOCKQUOTE', { class: 'aside' }) ||
            getNearest(range.commonAncestorContainer, root, 'BLOCKQUOTE', { class: 'page-panel' }) ||
            root;
    }
    moveRangeBoundariesUpTree( range, blockContainer ); 
    frag = extractContentsOfRange( range, blockContainer, root );

    // 4. Modify tree of fragment and reinsert.
    insertNodeInRange( range, modify.call( this, frag ) );

    // 5. Merge containers at edges
    // SMW: Skip merging containers. Seems the right decision for our model.
    /*
    if ( range.endOffset < range.endContainer.childNodes.length ) {
        mergeContainers( range.endContainer.childNodes[ range.endOffset ], root );
    }
    mergeContainers( range.startContainer.childNodes[ range.startOffset ], root );
    */

    // 6. Restore selection
    this._getRangeAndRemoveBookmark( range );
    this.setSelection( range );
    this._updatePath( range, true );

    // 7. We're not still in an undo state
    if ( !canObserveMutations ) {   
        this._docWasChanged();
    }

    return this;
};


var increaseBlockQuoteLevel = function ( frag ) {
    return this.createElement( 'BLOCKQUOTE',
        this._config.tagAttributes.blockquote, [
            frag
        ]);
};

var decreaseBlockQuoteLevel = function ( frag ) {
    var blockquotes = frag.querySelectorAll( 'blockquote' );
    var lastBlockquote = blockquotes[ blockquotes.length - 1 ];
    replaceWith( lastBlockquote, empty( lastBlockquote ) );

    return frag;
};



var removeBlockQuote = function (/* frag */) {
    return this.createDefaultBlock([
        this.createElement( 'INPUT', {
            id: startSelectionId,
            type: 'hidden'
        }),
        this.createElement( 'INPUT', {
            id: endSelectionId,
            type: 'hidden'
        })
    ]);
};

var makeList = function ( self, frag, type, variant ) {
    var tagAttributeType = variant != undefined ? variant : type.toLowerCase();

    var walker = getBlockWalker( frag, self._root ),
        node, tag, prev, newLi,
        tagAttributes = self._config.tagAttributes,
        listAttrs = tagAttributes[ tagAttributeType ] || {class: ''},
        listItemAttrs = tagAttributes.li;

    while ( node = walker.nextNode() ) {
        tag = node.parentNode.nodeName;
        if ( tag !== 'LI' ) {
            newLi = self.createElement( 'LI', listItemAttrs );
            if ( node.dir ) {
                newLi.dir = node.dir;
            }

            // Have we replaced the previous block with a new <ul>/<ol>?
            if ( ( prev = node.previousSibling ) &&
                    prev.nodeName === type ) {
                prev.appendChild( newLi );
            }
            // Otherwise, replace this block with the <ul>/<ol>
            else {
                replaceWith(
                    node,
                    self.createElement( type, listAttrs, [
                        newLi
                    ])
                );
            }
            newLi.appendChild( node );
        } else {
            node = node.parentNode.parentNode;
            tag = node.nodeName;
            if ( (tag !== type || node.getAttribute('class') !== listAttrs.class) && ( /^[OU]L$/.test( tag ) ) ) {
                replaceWith( node,
                    self.createElement( type, listAttrs, [ empty( node ) ] )
                );
            }
        }
    }
};

var makeUnorderedList = function ( frag ) {
    makeList( this, frag, 'UL' );
    return frag;
};

var makeOrderedList = function ( frag ) {
    makeList( this, frag, 'OL' );
    return frag;
};

var removeList = function ( frag ) {
    var lists = frag.querySelectorAll( 'UL, OL' ),
        i, l, ll, list, listFrag, children, child;
    for ( i = 0, l = lists.length; i < l; i += 1 ) {
        list = lists[i];
        listFrag = empty( list );
        children = listFrag.childNodes;
        ll = children.length;
        while ( ll-- ) {
            child = children[ll];
            replaceWith( child, empty( child ) );
        }
        fixContainer( listFrag, this._root );
        replaceWith( list, listFrag );
    }
    return frag;
};

var increaseListLevel = function ( frag ) {
    var items = frag.querySelectorAll( 'LI' ),
        i, l, item,
        type, newParent,
        tagAttributes = this._config.tagAttributes,
        listItemAttrs = tagAttributes.li,
        listAttrs;
    for ( i = 0, l = items.length; i < l; i += 1 ) {
        item = items[i];
        if ( !isContainer( item.firstChild ) ) {
            // type => 'UL' or 'OL'
            type = item.parentNode.nodeName;
            newParent = item.previousSibling;
            if ( !newParent || !( newParent = newParent.lastChild ) ||
                    newParent.nodeName !== type ) {
                listAttrs = tagAttributes[ type.toLowerCase() ];
                replaceWith(
                    item,
                    this.createElement( 'LI', listItemAttrs, [
                        newParent = this.createElement( type, listAttrs )
                    ])
                );
            }
            newParent.appendChild( item );
        }
    }
    return frag;
};

var decreaseListLevel = function ( frag ) {
    var root = this._root;
    var items = frag.querySelectorAll( 'LI' );
    Array.prototype.filter.call( items, function ( el ) {
        return !isContainer( el.firstChild );
    }).forEach( function ( item ) {
        var parent = item.parentNode,
            newParent = parent.parentNode,
            first = item.firstChild,
            node = first,
            next;
        if ( item.previousSibling ) {
            parent = split( parent, item, newParent, root );
        }
        while ( node ) {
            next = node.nextSibling;
            if ( isContainer( node ) ) {
                break;
            }
            newParent.insertBefore( node, parent );
            node = next;
        }
        if ( newParent.nodeName === 'LI' && first.previousSibling ) {
            split( newParent, first, newParent.parentNode, root );
        }
        while ( item !== frag && !item.childNodes.length ) {
            parent = item.parentNode;
            parent.removeChild( item );
            item = parent;
        }
    }, this );
    fixContainer( frag, root );
    return frag;
};

proto._ensureBottomLine = function ( container ) {
    var root = container === undefined ? this._root : container;
    var last = root.lastElementChild;
    if ( !last ||
            last.nodeName !== this._config.blockTag || !isBlock( last ) ) {
        root.appendChild( this.createDefaultBlock() );
    }
};

// --- Keyboard interaction ---

proto.setKeyHandler = function ( key, fn ) {
    this._keyHandlers[ key ] = fn;
    return this;
};

// --- Get/Set data ---

proto._getHTML = function () {
    return this._root.innerHTML;
};

proto._setHTML = function ( html ) {
    var root = this._root;
    var node = root;
    node.innerHTML = html;
    do {
        fixCursor( node, root );
    } while ( node = getNextBlock( node, root ) );
    this._ignoreChange = true;
};

proto.getHTML = function ( withBookMark ) {
    var brs = [],
        root, node, fixer, html, l, range;
    if ( withBookMark && ( range = this.getSelection() ) ) {
        this._saveRangeToBookmark( range );
    }
    if ( useTextFixer ) {
        root = this._root;
        node = root;
        while ( node = getNextBlock( node, root ) ) {
            if ( !node.textContent && !node.querySelector( 'BR' ) ) {
                fixer = this.createElement( 'BR' );
                node.appendChild( fixer );
                brs.push( fixer );
            }
        }
    }
    html = this._getHTML().replace( /\u200B/g, '' );
    if ( useTextFixer ) {
        l = brs.length;
        while ( l-- ) {
            detach( brs[l] );
        }
    }
    if ( range ) {
        this._getRangeAndRemoveBookmark( range );
    }

    return html;
};

proto.setHTML = function ( html, skipUndo, skipClean ) {
    var frag = this._doc.createDocumentFragment();
    var div = this.createElement( 'DIV' );
    var root = this._root;
    var child;

    // Parse HTML into DOM tree
    div.innerHTML = html;
    frag.appendChild( empty( div ) );
    if (!skipClean) {
        cleanTree( frag );
        cleanupBRs( frag, root );
    }

//    fixContainer( frag, root );

    // Fix cursor
//    var node = frag;
//    while ( node = getNextBlock( node, root ) ) {
//        fixCursor( node, root );
//    }

    // Don't fire an input event
    this._ignoreChange = true;

    // Remove existing root children
    while ( child = root.lastChild ) {
        root.removeChild( child );
    }

    // And insert new content
    root.appendChild( frag );
    fixContainer( root, root );

    if ( !skipUndo ) {
        // Reset the undo stack
        this._undoIndex = -1;
        this._undoStack.length = 0;
        this._undoScrollTopStack.length = 0;
        this._undoStackLength = 0;
        this._isInUndoState = false;

        // Record undo state
        var range = this._getRangeAndRemoveBookmark() ||
            this._createRange( root.firstChild, 0 );
        // this.saveUndoState( range );
        // IE will also set focus when selecting text so don't use
        // setSelection. Instead, just store it in lastSelection, so if
        // anything calls getSelection before first focus, we have a range
        // to return.
        this._lastSelection = range;
        this._updatePath( range, true );
    }
    return this;
};

proto.insertElement = function ( el, range ) {
    if ( !range ) { range = this.getSelection(); }
    range.collapse( true );
    if ( isInline( el ) ) {
        insertNodeInRange( range, el );
        range.setStartAfter( el );
    } else {
        // Get containing block node.
        var root = this._root;
        var splitNode = getStartBlockOfRange( range, root ) || root;
        var parent, nodeAfterSplit;
        // While at end of container node, move up DOM tree.
        while ( splitNode !== root && !splitNode.nextSibling ) {
            splitNode = splitNode.parentNode;
        }
        // If in the middle of a container node, split up to root.
        if ( splitNode !== root ) {
            parent = splitNode.parentNode;
            nodeAfterSplit = split( parent, splitNode.nextSibling, root, root );
        }
        if ( nodeAfterSplit ) {
            root.insertBefore( el, nodeAfterSplit );
        } else {
            root.appendChild( el );
            // Insert blank line below block.
            nodeAfterSplit = this.createDefaultBlock();
            root.appendChild( nodeAfterSplit );
        }
        range.setStart( nodeAfterSplit, 0 );
        range.setEnd( nodeAfterSplit, 0 );
        moveRangeBoundariesDownTree( range );
    }
    this.focus();
    this.setSelection( range );
    this._updatePath( range );
    return this;
};

proto.insertImage = function ( src, attributes ) {
    var self = this;
    
    var range = self.getSelection();
    self._recordUndoState( range );
    self._getRangeAndRemoveBookmark( range );

    var img = this.createElement( 'IMG', mergeObjects({
        src: src
    }, attributes ));
    this.insertElement( img );
    self._docWasChanged();

    var imgRange = self._doc.createRange();
    imgRange.selectNode( img );
    imgRange.collapse( false );
    self._recordUndoState( imgRange );
    self._getRangeAndRemoveBookmark( imgRange );

    return img;
};

var linkRegExp = /\b((?:(?:ht|f)tps?:\/\/|www\d{0,3}[.]|[a-z0-9.\-]+[.][a-z]{2,}\/)(?:[^\s()<>]+|\([^\s()<>]+\))+(?:\((?:[^\s()<>]+|(?:\([^\s()<>]+\)))*\)|[^\s`!()\[\]{};:'".,<>?«»“”‘’]))|([\w\-.%+]+@(?:[\w\-]+\.)+[A-Z]{2,}\b)/i;

var addLinks = function ( frag, root ) {
    var doc = frag.ownerDocument,
        walker = new TreeWalker( frag, SHOW_TEXT,
                function ( node ) {
            return !getNearest( node, root, 'A' );
        }, false ),
        node, data, parent, match, index, endIndex, child;
    while ( node = walker.nextNode() ) {
        data = node.data;
        parent = node.parentNode;
        while ( match = linkRegExp.exec( data ) ) {
            index = match.index;
            endIndex = index + match[0].length;
            if ( index ) {
                child = doc.createTextNode( data.slice( 0, index ) );
                parent.insertBefore( child, node );
            }
            child = doc.createElement( 'A' );
            child.textContent = data.slice( index, endIndex );
            child.href = match[1] ?
                /^(?:ht|f)tps?:/.test( match[1] ) ?
                    match[1] :
                    'http://' + match[1] :
                'mailto:' + match[2];
            parent.insertBefore( child, node );
            node.data = data = data.slice( endIndex );
        }
    }
};

// Insert HTML at the cursor location. If the selection is not collapsed
// insertTreeFragmentIntoRange will delete the selection so that it is replaced
// by the html being inserted.
proto.insertHTML = function ( html, isPaste ) {
    var range = this.getSelection(),
        frag = this._doc.createDocumentFragment(),
        div = this.createElement( 'DIV' );

    // Parse HTML into DOM tree
    div.innerHTML = html;
    frag.appendChild( empty( div ) );

    // Record undo checkpoint
    this.saveUndoState( range );

    try {
        var root = this._root;
        var node = frag;
        var event = {
            fragment: frag,
            preventDefault: function () {
                this.defaultPrevented = true;
            },
            defaultPrevented: false
        };

        addLinks( frag, root );
        var errorCallback = isPaste ? this._onPasteErrorCallback : null;
        cleanTree( frag, false, errorCallback );
        cleanupBRs( frag, root );
        removeEmptyInlines( frag );
        frag.normalize();

        while ( node = getNextBlock( node, root ) ) {
            fixCursor( node, root );
        }

        if ( isPaste ) {
            this.fireEvent( 'willPaste', event );
        }

        if ( !event.defaultPrevented ) {
            insertTreeFragmentIntoRange( range, event.fragment, root );
            if ( !canObserveMutations ) {
                this._docWasChanged();
            }
            range.collapse( false );
            fixContainer(root, root);

            if ( isPaste ) {
                if ( this._onPasteCallback ) {
                    this._onPasteCallback();
                }
            }
        }

        this.setSelection( range );
        this._updatePath( range, true );
    } catch ( error ) {
        this.didError( error );
    }
    return this;
};

proto.insertPlainText = function ( plainText, isPaste ) {
    var lines = plainText.split( '\n' ),
        i, l, line;
    for ( i = 0, l = lines.length; i < l; i += 1 ) {
        line = lines[i];
        line = line.split( '&' ).join( '&amp;' )
                   .split( '<' ).join( '&lt;'  )
                   .split( '>' ).join( '&gt;'  )
                   .replace( / (?= )/g, '&nbsp;' );
        // Wrap all but first/last lines in <div></div>
        if ( i && i + 1 < l ) {
            line = '<DIV>' + ( line || '<BR>' ) + '</DIV>';
        }
        lines[i] = line;
    }
    return this.insertHTML( lines.join( '' ), isPaste );
};

// --- Formatting ---

var command = function ( method, arg, arg2 ) {
    return function () {
        this[ method ]( arg, arg2 );
        return this.focus();
    };
};

proto.addStyles = function ( styles ) {
    if ( styles ) {
        var head = this._doc.documentElement.firstChild,
            style = this.createElement( 'STYLE', {
                type: 'text/css'
            });
        style.appendChild( this._doc.createTextNode( styles ) );
        head.appendChild( style );
    }
    return this;
};

proto.underline = command( 'changeFormat', { tag: 'U' } );
proto.strikethrough = command( 'changeFormat', { tag: 'S' } );
proto.subscript = command( 'changeFormat', { tag: 'SUB' }, { tag: 'SUP' } );
proto.superscript = command( 'changeFormat', { tag: 'SUP' }, { tag: 'SUB' } );

proto.removeUnderline = command( 'changeFormat', null, { tag: 'U' } );
proto.removeStrikethrough = command( 'changeFormat', null, { tag: 'S' } );
proto.removeSubscript = command( 'changeFormat', null, { tag: 'SUB' } );
proto.removeSuperscript = command( 'changeFormat', null, { tag: 'SUP' } );

proto.makeLink = function ( url, attributes ) {
    var range = this.getSelection();
    if ( range.collapsed ) {
        var protocolEnd = url.indexOf( ':' ) + 1;
        if ( protocolEnd ) {
            while ( url[ protocolEnd ] === '/' ) { protocolEnd += 1; }
        }
        insertNodeInRange(
            range,
            this._doc.createTextNode( url.slice( protocolEnd ) )
        );
    }

    if ( !attributes ) {
        attributes = {};
    }
    attributes.href = url;

    this.changeFormat({
        tag: 'A',
        attributes: attributes
    }, {
        tag: 'A'
    }, range );
    return this.focus();
};
proto.removeLink = function () {
    this.changeFormat( null, {
        tag: 'A'
    }, this.getSelection(), true );
    return this.focus();
};

proto.setFontFace = function ( name ) {
    this.changeFormat({
        tag: 'SPAN',
        attributes: {
            'class': 'font',
            style: 'font-family: ' + name + ', sans-serif;'
        }
    }, {
        tag: 'SPAN',
        attributes: { 'class': 'font' }
    });
    return this.focus();
};
proto.setFontSize = function ( size ) {
    this.changeFormat({
        tag: 'SPAN',
        attributes: {
            'class': 'size',
            style: 'font-size: ' +
                ( typeof size === 'number' ? size + 'px' : size )
        }
    }, {
        tag: 'SPAN',
        attributes: { 'class': 'size' }
    });
    return this.focus();
};

proto.setTextColour = function ( colour ) {
    this.changeFormat({
        tag: 'SPAN',
        attributes: {
            'class': 'colour',
            style: 'color:' + colour
        }
    }, {
        tag: 'SPAN',
        attributes: { 'class': 'colour' }
    });
    return this.focus();
};

proto.setHighlightColour = function ( colour ) {
    this.changeFormat({
        tag: 'SPAN',
        attributes: {
            'class': 'highlight',
            style: 'background-color:' + colour
        }
    }, {
        tag: 'SPAN',
        attributes: { 'class': 'highlight' }
    });
    return this.focus();
};

proto.setTextAlignment = function ( alignment ) {
    this.forEachBlock( function ( block ) {
        block.className = ( block.className
            .split( /\s+/ )
            .filter( function ( klass ) {
                return !( /align/.test( klass ) );
            })
            .join( ' ' ) +
            ' align-' + alignment ).trim();
        block.style.textAlign = alignment;
    }, true );
    return this.focus();
};

proto.setTextDirection = function ( direction ) {
    this.forEachBlock( function ( block ) {
        block.dir = direction;
    }, true );
    return this.focus();
};

function removeFormatting ( self, root, clean ) {
    var node, next;
    for ( node = root.firstChild; node; node = next ) {
        next = node.nextSibling;
        if ( isInline( node ) ) {
            if ( node.nodeType === TEXT_NODE || node.nodeName === 'BR' || node.nodeName === 'IMG' ) {
                clean.appendChild( node );
                continue;
            }
        } else if ( isBlock( node ) ) {
            clean.appendChild( self.createDefaultBlock([
                removeFormatting(
                    self, node, self._doc.createDocumentFragment() )
            ]));
            continue;
        }
        removeFormatting( self, node, clean );
    }
    return clean;
}

proto.removeAllFormatting = function ( range ) {
    if ( !range && !( range = this.getSelection() ) || range.collapsed ) {
        return this;
    }

    var root = this._root;
    var stopNode = range.commonAncestorContainer;
    while ( stopNode && !isBlock( stopNode ) ) {
        stopNode = stopNode.parentNode;
    }
    if ( !stopNode ) {
        expandRangeToBlockBoundaries( range, root );
        stopNode = root;
    }
    if ( stopNode.nodeType === TEXT_NODE ) {
        return this;
    }

    // Record undo point
    this.saveUndoState( range );

    // Avoid splitting where we're already at edges.
    moveRangeBoundariesUpTree( range, stopNode );

    // Split the selection up to the block, or if whole selection in same
    // block, expand range boundaries to ends of block and split up to root.
    var doc = stopNode.ownerDocument;
    var startContainer = range.startContainer;
    var startOffset = range.startOffset;
    var endContainer = range.endContainer;
    var endOffset = range.endOffset;

    // Split end point first to avoid problems when end and start
    // in same container.
    var formattedNodes = doc.createDocumentFragment();
    var cleanNodes = doc.createDocumentFragment();
    var nodeAfterSplit = split( endContainer, endOffset, stopNode, root );
    var nodeInSplit = split( startContainer, startOffset, stopNode, root );
    var nextNode, _range, childNodes;

    // Then replace contents in split with a cleaned version of the same:
    // blocks become default blocks, text and leaf nodes survive, everything
    // else is obliterated.
    while ( nodeInSplit !== nodeAfterSplit ) {
        nextNode = nodeInSplit.nextSibling;
        formattedNodes.appendChild( nodeInSplit );
        nodeInSplit = nextNode;
    }
    removeFormatting( this, formattedNodes, cleanNodes );
    cleanNodes.normalize();
    nodeInSplit = cleanNodes.firstChild;
    nextNode = cleanNodes.lastChild;

    // Restore selection
    childNodes = stopNode.childNodes;
    if ( nodeInSplit ) {
        stopNode.insertBefore( cleanNodes, nodeAfterSplit );
        startOffset = indexOf.call( childNodes, nodeInSplit );
        endOffset = indexOf.call( childNodes, nextNode ) + 1;
    } else {
        startOffset = indexOf.call( childNodes, nodeAfterSplit );
        endOffset = startOffset;
    }

    // Merge text nodes at edges, if possible
    _range = {
        startContainer: stopNode,
        startOffset: startOffset,
        endContainer: stopNode,
        endOffset: endOffset
    };
    _mergeInlines( stopNode, _range );
    range.setStart( _range.startContainer, _range.startOffset );
    range.setEnd( _range.endContainer, _range.endOffset );

    // And move back down the tree
    moveRangeBoundariesDownTree( range );

    this.setSelection( range );
    this._updatePath( range, true );

    return this.focus();
};

proto.increaseQuoteLevel = command( 'modifyBlocks', increaseBlockQuoteLevel );
var decreaseQuoteLevel = command( 'modifyBlocks', decreaseBlockQuoteLevel );

proto.makeUnorderedList = command( 'modifyBlocks', makeUnorderedList );
proto.makeOrderedList = command( 'modifyBlocks', makeOrderedList );

proto.removeList = command( 'modifyBlocks', removeList );

proto.increaseListLevel = command( 'modifyBlocks', increaseListLevel );
proto.decreaseListLevel = command( 'modifyBlocks', decreaseListLevel );

//          _____                    _____                    _____          
//         /\    \                  /\    \                  /\    \         
//        /::\    \                /::\____\                /::\____\        
//       /::::\    \              /::::|   |               /:::/    /        
//      /::::::\    \            /:::::|   |              /:::/   _/___      
//     /:::/\:::\    \          /::::::|   |             /:::/   /\    \     
//    /:::/__\:::\    \        /:::/|::|   |            /:::/   /::\____\    
//    \:::\   \:::\    \      /:::/ |::|   |           /:::/   /:::/    /    
//  ___\:::\   \:::\    \    /:::/  |::|___|______    /:::/   /:::/   _/___  
// /\   \:::\   \:::\    \  /:::/   |::::::::\    \  /:::/___/:::/   /\    \ 
///::\   \:::\   \:::\____\/:::/    |:::::::::\____\|:::|   /:::/   /::\____\
//\:::\   \:::\   \::/    /\::/    / ~~~~~/:::/    /|:::|__/:::/   /:::/    /
// \:::\   \:::\   \/____/  \/____/      /:::/    /  \:::\/:::/   /:::/    / 
//  \:::\   \:::\    \                  /:::/    /    \::::::/   /:::/    /  
//   \:::\   \:::\____\                /:::/    /      \::::/___/:::/    /   
//    \:::\  /:::/    /               /:::/    /        \:::\__/:::/    /    
//     \:::\/:::/    /               /:::/    /          \::::::::/    /     
//      \::::::/    /               /:::/    /            \::::::/    /      
//       \::::/    /               /:::/    /              \::::/    /       
//        \::/    /                \::/    /                \::/____/        
//         \/____/                  \/____/                  ~~              


// Functions
var createAllowedContentMap = function ( classifications, allowedTags ) {
return Object.keys(classifications).reduce( function( acc, classification ) {
        classifications[classification].forEach( function( tag ){ 
            if ( allowedTags.indexOf( tag ) !== -1 ) {
                acc[tag] = classification; 
            }
        });
        return acc;
    }, {});

}

var createTranslationMap = function ( ta, allowedSmwTags ) {
    var blockquote = ta.blockquote != undefined ? 'BLOCKQUOTE.' + ta.blockquote.class : 'BLOCKQUOTE';
    var aside = 'BLOCKQUOTE.' + ta.aside.class;
    var pagePanel = 'BLOCKQUOTE.' + ta.pagePanel.class;
    //var aside = 'ASIDE';
    var bulleted = ta.ul != undefined ? 'UL.' + ta.ul.class : 'UL';
    var noLabels = 'UL.' + ta.noLabels.class;
    var hr = 'IMG.' + ta.pageBreak.class;
    var translations = {
        'B' : 'strong',
        'I' : 'em',
        'H1' : 'heading',
        'H2' : 'heading',
        'H3' : 'heading',
        'H4' : 'heading',
        'OL' : 'list',
        'A' : 'link',
        'MYWO-CONTENT-WIDGET' : 'smwWidget',
        'BR' : 'br'
    };
    translations[blockquote] = 'blockquote';
    translations[aside] = 'aside';
    translations[pagePanel] = 'pagePanel';
    translations[bulleted] = 'list';
    translations[noLabels] = 'list';
    translations[hr] = 'hr';

    for ( var htmlTag in translations ) {
        if ( allowedSmwTags.indexOf( translations[ htmlTag ] ) === -1 )
            delete translations[ htmlTag ];
    }
    return translations;
};

var createHeader = function ( level ) {
    var tag = 'H' + level;
    return function( frag ) { 
            
        return createOrReplaceHeader( this, frag, tag ) 
    };
};

var makeUnlabeledList = function ( frag ) {
    makeList( this, frag, 'UL', 'noLabels' );
    return frag;
};

var createBlockQuote = function ( frag ) {
    var aside = frag.querySelector('blockquote.aside');
    if ( aside ) {
        //wrap blockquote in aside
        var blockquote = createOnce( this, Array.prototype.slice.call(aside.childNodes) , 'BLOCKQUOTE', 'blockquote' );
        aside.appendChild( blockquote );
        return frag;
    } else {
        return createOnce( this, frag, 'BLOCKQUOTE', 'blockquote' );    
    }
};

var createAside = function ( frag ) {
    return createOnce( this, frag, 'BLOCKQUOTE', 'aside' );
};

var createPagePanel = function ( frag ) {
    return createOnce( this, frag, 'BLOCKQUOTE', 'pagePanel' );
};

var createOnce = function ( self, frag, tag, attributeKey ) {
    var attributeKey = attributeKey != undefined ? attributeKey : tag;
    var attributes = self._config.tagAttributes[attributeKey]
    if ( frag.constructor === Array ) {
        return self.createElement( tag, attributes, frag );
    } else {
        var tags = frag.querySelector(tag+'.'+attributes.class);
        if ( tags === null ) {
            return self.createElement( tag, attributes, [ frag ]);
        } else {
            return frag;
        }    
    }
      
};

var createOrReplaceHeader = function ( self, frag, tag ) {
    var header, headers, children,
        tagAttributes = self._config.tagAttributes,
        headerAttrs = tagAttributes[ tag ];

    headers = frag.querySelectorAll( 'h1, h2, h3, h4' );
    if ( !headers || headers.length === 0 ) {
        children = [ frag ];
        header = self.createElement( tag, headerAttrs, children );
        return header;
    } else {
        for ( var i = 0; i < headers.length; i++ ) {
            header = headers[i];
            var newHeader =  self.createElement( tag, headerAttrs, header.childNodes );
            replaceWith( header, newHeader ); 
        }
        return frag;
    }
    
};

var removeHeader = function ( frag ) {
    var headers = frag.querySelectorAll( 'h1, h2, h3, h4' );
    for (var i = 0; i < headers.length; i++ ) {
        var el = headers[i];
        // Modifies frag;
        replaceWith( el, empty( el ) );
    }
    return frag;
};

var removeAllBlockquotes = function ( frag ) {
    var blockquotes = frag.querySelectorAll( 'blockquote' );
    var attributes = this._config.tagAttributes.blockquote;
    removeAllBlockquotesHelper( blockquotes, attributes.class);
    return frag;
};

var removeAllAsides = function ( frag ) {
    var asides = frag.querySelectorAll( 'blockquote' );
    var attributes = this._config.tagAttributes.aside;
    removeAllBlockquotesHelper( asides, attributes.class );
    return frag;
};

var removeAllPagePanels = function ( frag ) {
    var pagePanels = frag.querySelectorAll( 'blockquote' );
    var attributes = this._config.tagAttributes.pagePanel;
    removeAllBlockquotesHelper( pagePanels, attributes.class );
    return frag;
};

var removeAllBlockquotesHelper = function( blockquotes, blockquoteClass ) {
    //Side effect (modifies frag)
    Array.prototype.filter.call( blockquotes, function ( blockquote ) {
        return blockquote.className === blockquoteClass;
    }).forEach( function ( el ) {
        replaceWith( el, empty( el ) );
    });
};  

proto.removeBlockquotes = function ( ) {
    var range = this.getSelection();
    var pattern = 'BLOCKQUOTE';
    this.modifyBlocks( removeAllBlockquotes, range, pattern );
    return this.focus();
};
proto.removeAsides = function ( ) {
    var range = this.getSelection();
    var pattern = 'BLOCKQUOTE';
    this.modifyBlocks( removeAllAsides, range, pattern, {class: 'aside'}, true );
    return this.focus();
};
proto.removePagePanels = function ( ) {
    var range = this.getSelection();
    var pattern = 'BLOCKQUOTE';
    this.modifyBlocks( removeAllPagePanels, range, pattern, {class: 'page-panel'}, true );
    return this.focus();
};
proto.insertSoftBreak = function ( ) {
    var self = this;

    var range = self.getSelection();

    if (!canInsertLineBreak(self, range)) {
        self.focus();
        return;
    }

    var br = self.createElement( 'BR' );

    self._recordUndoState( range );
    self._getRangeAndRemoveBookmark( range );

    insertTreeFragmentIntoRange( range, br, self._root);
    if ( !canObserveMutations ) {
        self._docWasChanged();
    }
    range.collapse( false );
    self.setSelection( range );
    self._updatePath( range, true );
    return self.focus();
};

var canInsertLineBreak = function(self, range) {
    var result = true;
    if (range.collapsed) {
        var currentNode = range.startContainer;
        var previousNode, nextNode;
        if (getNearestCallback(currentNode, self._root, isHeading)) {
            result = false;
        }
        else if (currentNode.nodeType === TEXT_NODE) {
            // If empty, and there is a br before or after, DENY!
            previousNode = currentNode.previousSibling;
            nextNode = currentNode.nextSibling;

            if (
                (!currentNode.data.slice(0, range.startOffset).trim() && (!previousNode || previousNode.nodeName === 'BR')) ||
                (!currentNode.data.slice(range.endOffset).trim() && nextNode && nextNode.parentNode.lastChild !== nextNode && nextNode.nodeName === 'BR')
            ) {
                result = false;
            }
        } else {
            currentNode = currentNode.childNodes[range.startOffset];
            if (currentNode) {
                previousNode = currentNode.previousSibling;
                nextNode = currentNode.nextSibling;

                if (currentNode.nodeName === 'BR' && (!previousNode || previousNode.nodeName === 'BR' || (nextNode && nextNode.parentNode.lastChild !== nextNode && nextNode.nodeName === 'BR') )) {
                    result = false;
                }
            }

        }
    } else {
        result = false;
    }
    return result;
};

proto.insertPageBreak = function ( ) {
    var self = this;

    var range = self.getSelection();
    var tagAttributes = this._config.tagAttributes;
    var pageBreakAttrs = tagAttributes[ 'pageBreak' ];
    var pageBreak = this.createElement( 'IMG', pageBreakAttrs );

    var block = self.createDefaultBlock( [ pageBreak ] );
    block.setAttribute( 'class', pageBreakAttrs.class + '-container' );

    self._recordUndoState( range );
    self._getRangeAndRemoveBookmark( range );

    if ( range.collapsed ) {
        var endP = getNearest( range.endContainer, self._root, 'P' );
        endP.parentNode.insertBefore( self.createDefaultBlock( [ ] ), block.nextSibling );
        endP.parentNode.insertBefore( block, endP.nextSibling );
        endP.parentNode.insertBefore( self.createDefaultBlock( [ ] ), block.nextSibling );
    } else {
        //Insert before
        var parent = range.startContainer.parentNode;
        parent.parentNode.insertBefore( block, parent );
    } 
    
    block.setAttribute('contenteditable', 'false');

    range.setStart( block.nextSibling, 0);
    self.focus();
    self.setSelection( range );
    self._updatePath( range );

    if ( !canObserveMutations ) {
        this._docWasChanged();
    }

    return self;
};

proto.bold = function () { return changeFormatExpandToWord( this, { tag : 'B' }, { tag : 'B' } ); };
proto.italic = function () { return changeFormatExpandToWord( this, { tag : 'I' }, { tag : 'I' } ); };
proto.removeBold = function () { return changeFormatExpandToWord( this, null, { tag : 'B' } ); }; //command( 'changeFormat', null, { tag: 'B' } );
proto.removeItalic = function () { return changeFormatExpandToWord( this, null, { tag : 'I' } ); }; //command( 'changeFormat', null, { tag: 'I' } );


var toggleInlineTag = function ( self, tag ) {
    self._removeZWS();
    var range = self.getSelection();
    if ( self.hasFormat( tag, null, range ) ) {
        return changeFormatExpandToWord( self, null, { tag: tag }, range );
    } else {
        return changeFormatExpandToWord( self, { tag: tag }, null, range );
    }
};

var toggleTag = function( self, tag, attributes, addCallback, removeCallback ) {
    var range = self.getSelection();
    var attrs = attributes != undefined ? attributes : null;
    if ( self.hasFormat( tag, attrs, range ) ) {
        return removeCallback();
    } else {
        return addCallback();
    }
};

var changeFormatExpandToWord = function ( self, add, remove, range ) {
    if ( !range ) { range = self.getSelection(); }
    var _startNode = range.startContainer, _endNode = range.endContainer;
    var _startOffset = range.startOffset, _endOffset = range.endOffset;
    //Check if collapsed and not on an empty row
    var isAfterTag = _startNode.nodeType !== TEXT_NODE;
    if ( range.collapsed && 
        _startOffset < _startNode.textContent.length && 
        _endOffset < _startNode.textContent.length && 
        _startNode.nodeType === TEXT_NODE ) {
        
        expandWord( range );
        
        self.changeFormat( add, remove, range );
      
    } else {
        self.changeFormat( add, remove, range );
    }
    
    return self.focus();
};

var isSmwInline = function ( self, tag ) {
    return self._config.inlineMarkedTypes.indexOf( tag ) !== -1;
};

proto.widgetRangeSelectNextParagraph = function( range ) {
    var widget; 
    if ( widget = getNearestCallback(range.startContainer, this._root, isWidget) ) {
        var node = widget.nextSibling;
        // Find next paragraph
        while ( node && !isParagraph( node ) ) {
            node = getNextBlock( node, this._root )
        }
        var newRange = this._createRange( node, 0 );
        moveRangeBoundariesDownTree( newRange );
        newRange.collapse( true );
        this.setSelection( newRange );
    }
    return this.focus();
};

// Tags must be in SMW form
proto.isAllowedIn = function ( self, tag, containerTag ) {
    var tags = [];
    var allInline = self._classifications.inlineWithText.concat(self._classifications.inlineWithAtomic);
    var classification = self._allowedContent[ containerTag ];
    switch ( classification ) {
        case 'containers':
            tags = allInline.concat( self._allowedBlocks[ containerTag ] );
            break;
        case 'blockAtomic':
            tags = [];
            break;
        case 'blockWithText':
            tags = allInline;
            break;
        case 'inlineWithAtomic':
            tags = [];
            break;
        case 'inlineWithText':
            tags = self._classifications.inlineWithText;
            break;
        default:
            tags = [];
            break;
    }
    //SUPER SPECIAL RULE for heading
    if ( containerTag === 'heading' ) {
        tags = tags.filter(function(e){return e != 'br'});
    }

    return tags.indexOf( tag ) !== -1;
};

function onSelectionChange ( event ) {
    var range = this.getSelection();

    var currentParent = range.commonAncestorContainer;
    while (currentParent && currentParent.nodeName !== 'BODY' && !isWidget(currentParent)) {
        currentParent = currentParent.parentNode;
    }
    if (isWidget(currentParent)) {
        range.selectNode(currentParent);
        this.setSelection(range);
    } else if (range.startContainer && range.collapsed && !isInline(range.startContainer) && !isBlock(range.startContainer)) {
        var childNodes = range.startContainer.childNodes;
        var node;
        if (childNodes.length > 0) {
            node = childNodes[Math.min(childNodes.length - 1, range.startOffset)];
        } else {
            node = range.startContainer;
        }
        var block = getNextBlock(node, this._root);
        var startOfBlock = true;
        if (!block) {
            block = getPreviousBlock(node, this._root);
            startOfBlock = false;
        }

        if (block) {
            if (startOfBlock) {
                range.setStart(block, 0);
            } else {
                range.setStart(block, getLength(block));
            }
            range.collapse(true);
            moveRangeBoundariesDownTree(range);
            this.setSelection(range);
        }
    }

}

var getSmwTagType = function ( smwTagTypes, tag ) {
    return smwTagTypes.reduce(function ( resultType, typeObj ) { 
        return typeObj.tags.indexOf( tag ) >= 0 ? typeObj.type : null;
    }, null);
};

var translateTag = function ( self, tag ) {
    return self._translateToSmw[ tag ];
}

proto.h1 = command( 'modifyBlocks', createHeader(1) );
proto.h2 = command( 'modifyBlocks', createHeader(2) );
proto.h3 = command( 'modifyBlocks', createHeader(3) );
proto.h4 = command( 'modifyBlocks', createHeader(4) );


proto.removeHeader = command( 'modifyBlocks', removeHeader );

proto.makeUnlabeledList = command( 'modifyBlocks', makeUnlabeledList );

proto.createBlockQuote = command( 'modifyBlocks', createBlockQuote );

proto.createAside = function() {
    // Ensure we capture the complete list
    var orgRange = this.getSelection();
    var range = orgRange.cloneRange();
    var listNode, expanded = false;

    listNode = getNearestCallback(range.startContainer, this._root, isList);
    if (listNode) {
        range.setStartBefore(listNode);
        expanded = true;
    }

    listNode = getNearestCallback(range.endContainer, this._root, isList);
    if (listNode) {
        range.setEndAfter(listNode);
        expanded = true;
    }

    this.modifyBlocks(createAside, range, null, null, false, expanded && orgRange);
    this.focus();
}
//proto.createAside = command( 'modifyBlocks', createAside );

proto.createPagePanel = function() {
    // Ensure we capture the complete list
    var orgRange = this.getSelection();
    var range = orgRange.cloneRange();
    var listNode, expanded = false;

    listNode = getNearestCallback(range.startContainer, this._root, isList);
    if (listNode) {
        range.setStartBefore(listNode);
        expanded = true;
    }

    listNode = getNearestCallback(range.endContainer, this._root, isList);
    if (listNode) {
        range.setEndAfter(listNode);
        expanded = true;
    }

    this.modifyBlocks(createPagePanel, range, null, null, true, expanded && orgRange);
    this.focus();
}

proto.addDefaultBlock = function () {
    this._ensureBottomLine();
};

proto.mergeInlines = function() {
    var root = this._root;
    var range = this._doc.createRange();
    range.selectNode( root )
    mergeInlines( root, range );
};

proto.fixContainers = function() {
    fixContainer( this._root, this._root );
    return this;
};

//  ================ API specifics  ===========================
proto.toggleStrong = function () {
    var tag = 'B';
    toggleInlineTag( this, tag );
    return this.focus();
};

proto.toggleEm = function () {
    var tag = 'I';
    toggleInlineTag( this, tag );
    return this.focus();
};

proto.toggleHr = function () {
    this.insertPageBreak();
    return this.focus();
};

proto.toggleBlockquote = function () {
    var self = this;
    var blockqouteAttributes = self._config.tagAttributes.blockquote;
    var addCallback = function(){ return self.createBlockQuote(); };
    var removeCallback = function(){ return self.removeBlockquotes(); };
    toggleTag( self, 'BLOCKQUOTE', blockqouteAttributes, addCallback, removeCallback );
    return this.focus();
};

proto.toggleAside = function () {
    var self = this;
    var asideAttributes = self._config.tagAttributes.aside;
    var addCallback = function(){ return self.createAside(); };
    var removeCallback = function(){ return self.removeAsides(); };
    toggleTag( self, 'BLOCKQUOTE', asideAttributes, addCallback, removeCallback );
    return this.focus();
};

proto.togglePagePanel = function () {
    var self = this;
    var asideAttributes = self._config.tagAttributes.pagePanel;
    var addCallback = function(){ return self.createPagePanel(); };
    var removeCallback = function(){ return self.removePagePanels(); };
    toggleTag( self, 'BLOCKQUOTE', asideAttributes, addCallback, removeCallback );
    return this.focus();
};

proto.setHeading = function ( level ) {
    if ( level === 0 ){
        return this.modifyBlocks( removeHeader );
    } else {
        return this.modifyBlocks( createHeader(level) );
    }
    return this.focus();
};

proto.setLink = function ( url, title ) {
    var range = this.getSelection();
    this.saveUndoState( range );

    var links = getElementsInRange(this._root, 'A', null, range );

    if ( links.length > 0 ) {
        //Update first link found
        links[0].setAttribute('href', url);
        if ( title ) {
            links[0].setAttribute('title', title);
        }
    } else {
        if ( range.collapsed ) {
            expandWord( range );
        }
        var attributes; 
        if ( title ) {
            attributes = {'href': url, 'title': title};
        } else {
            attributes = {'href': url};
        }
        var contents = range.extractContents();
        //Asumes that all children are allowed inside an a-tag
        var a = this.createElement( 'A', attributes, Array.prototype.slice.call( contents.childNodes ) );
        insertNodeInRange( range, a );
    }

    if ( !canObserveMutations ) {
        this._docWasChanged();
    }
    
    return this.focus();
};


/**
 * Finds all elements in a range that matches the specified tagName and attributes.
 * This method returns elements found both among children and ancestors
 *
 * @param {Range} range
 * @returns {Array} A list with all found nodes
 */
function getElementsInRange(root, tag, attributes, range ) {
    // 1. Normalise the arguments and get selection
    tag = tag.toUpperCase();
    if ( !attributes ) { attributes = {}; }
    if ( !range && !( range = this.getSelection() ) ) {
        return [];
    }

    // Sanitize range to prevent weird IE artifacts
    if ( !range.collapsed &&
            range.startContainer.nodeType === TEXT_NODE &&
            range.startOffset === range.startContainer.length &&
            range.startContainer.nextSibling ) {
        range.setStartBefore( range.startContainer.nextSibling );
    }
    if ( !range.collapsed &&
            range.endContainer.nodeType === TEXT_NODE &&
            range.endOffset === 0 &&
            range.endContainer.previousSibling ) {
        range.setEndAfter( range.endContainer.previousSibling );
    }

    // If the common ancestor is inside the tag we require, we definitely
    // have the format.
    var common = range.commonAncestorContainer,
        walker, node, result = [];
    var nearest = getNearest( common, root, tag, attributes );
    if ( nearest ) {
        result.push(nearest);
    }

    // If common ancestor is a text node and doesn't have the format, we
    // definitely don't have it.
    if ( common.nodeType === TEXT_NODE ) {
        return result;
    }

    // Otherwise, check each text node at least partially contained within
    // the selection and make sure all of them have the format we want.
    walker = new TreeWalker( common, SHOW_ELEMENT, function ( node ) {
        return isNodeContainedInRange( range, node, true );
    });

    while ( node = walker.nextNode() ) {
        //Has any of the children the tag?
        if ( hasTagAttributes( node, tag, attributes ) ) {
            result.push(node);
        }
    }
    return result;
}

proto.canUndo = function () {
    return this._canUndo;
};

proto.canRedo = function () {
    return this._canRedo;
};


proto.setListFormatting = function ( listType ) {
    var range = this.getSelection();
    var pattern = "[OU]L";

    var rangeCollapsed = range.collapsed;

    if ( !listType ) {
        this.modifyBlocks( removeList, range, pattern );
    } else if ( listType === 'ordered' ) {
        this.modifyBlocks( makeOrderedList, range, pattern );
    } else if ( listType === 'bulleted' ) {
        this.modifyBlocks( makeUnorderedList, range, pattern );
    } else if ( listType === 'noLabels' ) {
        this.modifyBlocks( makeUnlabeledList, range, pattern );
    }

    var selection = this.getSelection();
    if ( rangeCollapsed && !selection.collapsed ) {
        var startBlock = getStartBlockOfRange( selection, this._root );
        if (startBlock) {
            var newRange = this._doc.createRange();
            newRange.setStart( startBlock, 0 );
            newRange.collapse( true );
            this.setSelection( newRange );
            console.log('Fixing selection', newRange);
        }
    }

    return this.focus();
};

proto.setWidget = function( widgetHtml ) {
    this.insertHTML(widgetHtml);
    return this;
}

var getListType = function ( self, list ) {
    switch ( list ) {
        case 'UL.' + self._config.tagAttributes.noLabels.class:
            return 'noLabels';
            break;
        case 'UL.' + self._config.tagAttributes.ul.class:
            return 'bulleted'
            break;
        case 'OL':
            return 'ordered';
            break;
    };

};

proto.getFormattingInfoFromCurrentSelection = function () {
    var self = this;
    //List of all tags
    var squireTags = self._validTags;
    var selection = self.getSelection();
    var commonAncestor = selection.commonAncestorContainer;
    var ancestorIsBody = hasTagAttributes(commonAncestor, 'BODY');
    var ancestorIsAside = hasTagAttributes(commonAncestor, 'BLOCKQUOTE', self._config.tagAttributes.aside);
    var ancestorIsPagePanel = hasTagAttributes(commonAncestor, 'BLOCKQUOTE', self._config.tagAttributes.pagePanel);

    var formattingInfoMap = {};
    var usedSmwTagToElementsMap = {};

    // Find all elements for each formatting type, throw away stuff when we find elements that map to the same smwTag
    var allSquireTagsWithElements = squireTags.map(function(squireTagWithClass) {
        var smwTag =  translateTag(self, squireTagWithClass);
        var split =  squireTagWithClass.split('.');
        var squireTag = split[0], tagClass = split[1];
        var attributes = tagClass === undefined ? self._config.tagAttributes[ squireTag ] : {'class': tagClass};
        var elements = getElementsInRange(self._root, squireTag, attributes, selection);

        if (elements.length > 0) {
            if (usedSmwTagToElementsMap[smwTag]) {
                usedSmwTagToElementsMap[smwTag] = usedSmwTagToElementsMap[smwTag].concat(elements);
            } else {
                usedSmwTagToElementsMap[smwTag] = elements;
            }
        }

        return {
            squireTag: squireTagWithClass,
            smwTag: translateTag(self, squireTagWithClass),
            elements: elements
        };
    });

    var usedSmwBlockTags = Object.keys(usedSmwTagToElementsMap).filter(function(smwTag) {
        return !isSmwInline(self, smwTag);
    });

    allSquireTagsWithElements.forEach(function(obj) {
        var smwTag = obj.smwTag;

        // If we already processed this smwTag, lets just skip it
        if (formattingInfoMap[smwTag] && (formattingInfoMap[smwTag].enabled || formattingInfoMap[smwTag].allowed)) {
            return;
        }
        var info = {};

        switch (smwTag) {
            // This can almost be checked with isSmwInline, but links are the exception
            case 'blockquote':
            case 'aside':
            case 'pagePanel':
            case 'heading':
            case 'list':
            case 'link':
            case 'smwWidget':
            case 'hr':
                // headings and lists have several squireTags that map to the same smwTag
                info.enabled = obj.elements.length === 1 && usedSmwTagToElementsMap[smwTag] && usedSmwTagToElementsMap[smwTag].length === 1;
                break;

            default:
                info.enabled = usedSmwTagToElementsMap[smwTag] && usedSmwTagToElementsMap[smwTag].length > 0;
        }

        var allowed = info.enabled || usedSmwBlockTags.every(function(usedBlockTag) {
            return self.isAllowedIn(self, smwTag , usedBlockTag) || self.isAllowedIn(self, usedBlockTag, smwTag);
        });

        // Now add even more restrictions!
        if (allowed) {
            switch (smwTag) {
                case 'aside':
                    allowed = (obj.elements.length === 1 && !ancestorIsBody) || obj.elements.length === 0;
                    break;
                case 'pagePanel':
                    allowed = (obj.elements.length === 1 && !ancestorIsBody) || obj.elements.length === 0;
                    break;

                case 'hr':
                    allowed = !usedSmwTagToElementsMap.aside && !usedSmwTagToElementsMap.pagePanel && selection.collapsed;
                    break;

                case 'link':
                    allowed = false;
                    if (!ancestorIsBody && !ancestorIsAside && !ancestorIsPagePanel && obj.elements.length <= 1 ) {
                        if (info.enabled || !selection.collapsed) {
                            allowed = true;
                        } else if (selection.collapsed) {
                            var clonedSelection = selection.cloneRange();
                            expandWord(clonedSelection);
                            if (!clonedSelection.collapsed) {
                                allowed = true;
                            }
                        }
                    }
                    break;

                case 'smwWidget':
                case 'br':
                    allowed = selection.collapsed;
                    break;

                default:
                    // As all text is wrapped in some tag, like p, blockquote, ol, etc. if the ancesor is aside or body, we are selecting more than 1 block
                    allowed = !ancestorIsBody && !ancestorIsAside && !ancestorIsPagePanel;

            }
        }
        info.allowed = allowed;

        // Add info special to some smwTags
        if (info.enabled) {
            switch (smwTag) {
                case 'list':
                    info.listType = getListType( self, obj.squireTag );
                    break;

                case 'heading':
                    info.depth = obj.squireTag[1]
                    break;

                case 'link':
                    info.href = obj.elements[0].getAttribute('href');
                    info.title = obj.elements[0].title;
                    break;
            }
        }
        formattingInfoMap[smwTag] = info;
    });
    return formattingInfoMap;

};

//Remove unwanted functionality
delete proto.underline;;
delete proto.strikethrough;
delete proto.subscript;
delete proto.superscript;

delete proto.removeUnderline;
delete proto.removeStrikethrough;
delete proto.removeSubscript;
delete proto.removeSuperscript;

delete proto.increaseListLevel;
//delete proto.decreaseListLevel;

delete proto.increaseQuoteLevel;
//delete proto.decreaseQuoteLevel;
