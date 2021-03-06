/* Copyright © 2011-2015 by Neil Jenkins. MIT Licensed. */

( function ( doc, undefined ) {

"use strict";

var DOCUMENT_POSITION_PRECEDING = 2; // Node.DOCUMENT_POSITION_PRECEDING
var ELEMENT_NODE = 1;                // Node.ELEMENT_NODE;
var TEXT_NODE = 3;                   // Node.TEXT_NODE;
var DOCUMENT_NODE = 9;               // Node.DOCUMENT_NODE;
var DOCUMENT_FRAGMENT_NODE = 11;     // Node.DOCUMENT_FRAGMENT_NODE;
var SHOW_ELEMENT = 1;                // NodeFilter.SHOW_ELEMENT;
var SHOW_TEXT = 4;                   // NodeFilter.SHOW_TEXT;

var START_TO_START = 0; // Range.START_TO_START
var START_TO_END = 1;   // Range.START_TO_END
var END_TO_END = 2;     // Range.END_TO_END
var END_TO_START = 3;   // Range.END_TO_START

var ZWS = '\u200B';

var win = doc.defaultView;

var ua = navigator.userAgent;

var isIOS = /iP(?:ad|hone|od)/.test( ua );
var isMac = /Mac OS X/.test( ua );

var isGecko = /Gecko\//.test( ua );
var isIElt11 = /Trident\/[456]\./.test( ua );
var isPresto = !!win.opera;
var isEdge = /Edge\//.test( ua );
var isWebKit = !isEdge && /WebKit\//.test( ua );
var isAndroid = /Android/.test( ua );

var ctrlKey = isMac ? 'meta-' : 'ctrl-';

var useTextFixer = isIElt11 || isPresto;
var cantFocusEmptyTextNodes = isIElt11 || isWebKit;
var losesSelectionOnBlur = isIElt11;

// Due to how angular works and how we inject content widgets, we cannot use the MutationObserver.
// The widgets can inject data at a later stage after an undo and thus trigger multiple mutation events, effectively canceling the undo state.
var canObserveMutations = false; //typeof MutationObserver !== 'undefined';

// Use [^ \t\r\n] instead of \S so that nbsp does not count as white-space
var notWS = /[^ \t\r\n]/;

var indexOf = Array.prototype.indexOf;

// Polyfill for FF3.5
if ( !Object.create ) {
    Object.create = function ( proto ) {
        var F = function () {};
        F.prototype = proto;
        return new F();
    };
}

/*
    Native TreeWalker is buggy in IE and Opera:
    * IE9/10 sometimes throw errors when calling TreeWalker#nextNode or
      TreeWalker#previousNode. No way to feature detect this.
    * Some versions of Opera have a bug in TreeWalker#previousNode which makes
      it skip to the wrong node.

    Rather than risk further bugs, it's easiest just to implement our own
    (subset) of the spec in all browsers.
*/

var typeToBitArray = {
    // ELEMENT_NODE
    1: 1,
    // ATTRIBUTE_NODE
    2: 2,
    // TEXT_NODE
    3: 4,
    // COMMENT_NODE
    8: 128,
    // DOCUMENT_NODE
    9: 256,
    // DOCUMENT_FRAGMENT_NODE
    11: 1024
};

function TreeWalker ( root, nodeType, filter ) {
    this.root = this.currentNode = root;
    this.nodeType = nodeType;
    this.filter = filter;
}

TreeWalker.prototype.nextNode = function () {
    var current = this.currentNode,
        root = this.root,
        nodeType = this.nodeType,
        filter = this.filter,
        node;
    while ( true ) {
        node = current.firstChild;
        while ( !node && current ) {
            if ( current === root ) {
                break;
            }
            node = current.nextSibling;
            if ( node && node.nodeType === ELEMENT_NODE && node.getAttribute('contenteditable') === "false" ) {
                //Don't traverse further
                this.currentNode = node;
                return node;
            } else if ( !node ) { 
                current = current.parentNode; 
            }
        }
        if ( !node ) {
            return null;
        }
        if ( ( typeToBitArray[ node.nodeType ] & nodeType ) &&
                filter( node ) ) {
            this.currentNode = node;
            return node;
        }
        current = node;
    }
};

TreeWalker.prototype.previousNode = function () {
    var current = this.currentNode,
        root = this.root,
        nodeType = this.nodeType,
        filter = this.filter,
        node;
    while ( true ) {
        if ( current === root ) {
            return null;
        } 
        node = current.previousSibling;
        if ( node && node.nodeType === ELEMENT_NODE && node.getAttribute('contenteditable') === "false" ) {
            //Don't traverse further
            this.currentNode = node;
            return node;

        } else if ( node ) {
            while ( current = node.lastChild ) {
                node = current;
            }
        } else {
            node = current.parentNode;
        }
        if ( !node ) {
            return null;
        }
        if ( ( typeToBitArray[ node.nodeType ] & nodeType ) &&
                filter( node ) ) {
            this.currentNode = node;
            return node;
        }
        current = node;
    }
};

// Previous node in post-order.
TreeWalker.prototype.previousPONode = function () {
    var current = this.currentNode,
        root = this.root,
        nodeType = this.nodeType,
        filter = this.filter,
        node;
    while ( true ) {
        node = current.lastChild;
        while ( !node && current ) {
            if ( current === root ) {
                break;
            }
            node = current.previousSibling;
            if ( !node ) { current = current.parentNode; }
        }
        if ( !node ) {
            return null;
        }
        if ( ( typeToBitArray[ node.nodeType ] & nodeType ) &&
                filter( node ) ) {
            this.currentNode = node;
            return node;
        }
        current = node;
    }
};

var inlineNodeNames  = /^(?:#text|A(?:BBR|CRONYM)?|B(?:R|D[IO])?|C(?:ITE|ODE)|D(?:ATA|EL|FN)|EM|FONT|HR|I(?:MG|NPUT|NS)?|KBD|Q|R(?:P|T|UBY)|S(?:AMP|MALL|PAN|TR(?:IKE|ONG)|U[BP])?|U|VAR|WBR)$/;
var smwInlineNodeNames = /^(?:#text|A|BR|B|I|STRONG|EM|INPUT)$/;

var leafNodeNames = {
    BR: 1,
    IMG: 1,
    INPUT: 1
};

function every ( nodeList, fn ) {
    var l = nodeList.length;
    while ( l-- ) {
        if ( !fn( nodeList[l] ) ) {
            return false;
        }
    }
    return true;
}

/**
 *
 * @param {Range} range
 */
function findNodeInRange(range, callback) {
    var treeWalker = range.commonAncestorContainer.ownerDocument.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    if (range.startContainer.nodeType === 1) {
        treeWalker.currentNode = range.startContainer.childNodes[range.startOffset];
    } else {
        treeWalker.currentNode = range.startContainer;
    }

    var endNode;
    if (range.endContainer.nodeType === 1) {
        endNode = range.endContainer.childNodes[range.endOffset];
    } else {
        endNode = range.endContainer;
    }

    var result = null;
    do {
        if (callback(treeWalker.currentNode)) {
            result = treeWalker.currentNode;
        }
    } while (!result && treeWalker.currentNode !== endNode && treeWalker.nextNode());

    return result;
}

function cloneRootWithRange(root, range) {
    var clonedRoot = root.cloneNode(true);

    // On iOS 9, range methods throw weird exceptions when used on nodes that are not attached to the document.
    // The workaround is to attach it to a document fragment.
    var fragment = root.ownerDocument.createDocumentFragment();
    fragment.appendChild(clonedRoot);

    var startContainerPath = [];
    var currentContainer = range.startContainer;
    while (currentContainer !== root) {
        startContainerPath.push(getNodeIndex(currentContainer));
        currentContainer = currentContainer.parentNode;
    }

    var endContainerPath = [];

    currentContainer = range.endContainer;
    while (currentContainer !== root) {
        endContainerPath.push(getNodeIndex(currentContainer));
        currentContainer = currentContainer.parentNode;
    }

    // Now lets find the cloned start and end
    var clonedRange = clonedRoot.ownerDocument.createRange();
    currentContainer = clonedRoot;
    while (startContainerPath.length > 0) {
        currentContainer = currentContainer.childNodes[startContainerPath.pop()];
    }
    clonedRange.setStart(currentContainer, range.startOffset);

    currentContainer = clonedRoot;
    while (endContainerPath.length > 0) {
        currentContainer = currentContainer.childNodes[endContainerPath.pop()];
    }
    clonedRange.setEnd(currentContainer, range.endOffset);

    return {
        fragment: fragment,
        root: clonedRoot,
        range: clonedRange
    };
}

// ---

function isLeaf ( node ) {
    return node.nodeType === ELEMENT_NODE &&
        !!leafNodeNames[ node.nodeName ];
}
function isInline ( node ) {
    return smwInlineNodeNames.test( node.nodeName );
}
function isBlock ( node ) {
    var type = node.nodeType;
    if ( type === ELEMENT_NODE ) {
        return isParagraph(node);
    }
    if ( type === DOCUMENT_FRAGMENT_NODE ) {
        return !isInline( node ) && every( node.childNodes, isInline );
    }
    return false;
}

function isContainer ( node ) {
    var type = node.nodeType;
    return ( type === ELEMENT_NODE || type === DOCUMENT_FRAGMENT_NODE ) &&
        !isInline( node ) && !isBlock( node );
}

function isBlockquote (node) {
    return node && getFullNodeName(node) === 'BLOCKQUOTE.blockquote';
}

function isAside (node) {
    return node && getFullNodeName(node) === 'BLOCKQUOTE.aside';
}

function isPagePanel (node) {
    return node && getFullNodeName(node) === 'BLOCKQUOTE.page-panel';
}

function isExpandableContainer (node) {
    return isAside(node) || isPagePanel(node);
}

function isList (node) {
    return node && /^[OU]L$/.test(node.nodeName);
}

function isListItem (node) {
    return node && node.nodeName === 'LI';
}

function isParagraph (node) {
    var fullNodeName = getFullNodeName(node);
    return node && fullNodeName === 'P' || fullNodeName === 'P.paragraph';
}

function isHeading (node) {
    return node && /^H\d$/.test(node.nodeName);
}

function isPagebreak (node) {
    return node && getFullNodeName(node) === 'P.page-break-container';
}

function isWidget (node) {
    return node && node.nodeName === 'MYWO-CONTENT-WIDGET';
}

function getBlockWalker ( node, root ) {
    var walker = new TreeWalker( root, SHOW_ELEMENT, isBlock );
    walker.currentNode = node;
    return walker;
}

function getPreviousBlock ( node, root ) {
    node = getBlockWalker( node, root ).previousNode();
    return node !== root ? node : null;
}
function getNextBlock ( node, root ) {
    node = getBlockWalker( node, root ).nextNode();
    return node !== root ? node : null;
}

function areAlike ( node, node2 ) {
    return !isLeaf( node ) && (
        node.nodeType === node2.nodeType &&
        node.nodeName === node2.nodeName &&
        node.className === node2.className &&
        ( ( !node.style && !node2.style ) ||
          node.style.cssText === node2.style.cssText )
    );
}
function hasTagAttributes ( node, tag, attributes ) {
    if ( node.nodeName !== tag ) {
        return false;
    }
    for ( var attr in attributes ) {
        if ( node.getAttribute( attr ) !== attributes[ attr ] ) {
            return false;
        }
    }
    return true;
}
function getNearest ( node, root, tag, attributes ) {
    while ( node && node !== root ) {
        if ( hasTagAttributes( node, tag, attributes ) ) {
            return node;
        }
        node = node.parentNode;
    }
    return null;
}
function getNearestCallback ( node, root, callback ) {
    while ( node && node !== root ) {
        if (callback(node)) {
            return node;
        }
        node = node.parentNode;
    }
    return null;
}
function getNearestLike ( node, tagLike, attributes ) {
    do {
        if ( node.nodeName.match( '^'+tagLike )) {
            if ( !attributes || hasTagAttributes(node, node.nodeName, attributes) ) {
                return node;
            }
        }
    } while ( node = node.parentNode );
    return null;
}

function isOrContains ( parent, node ) {
    while ( node ) {
        if ( node === parent ) {
            return true;
        }
        node = node.parentNode;
    }
    return false;
}

function getPath ( node, root ) {
    var path = '';
    var id, className, classNames, dir;
    if ( node && node !== root ) {
        path = getPath( node.parentNode, root );
        if ( node.nodeType === ELEMENT_NODE ) {
            path += ( path ? '>' : '' ) + node.nodeName;
            if ( id = node.id ) {
                path += '#' + id;
            }
            if ( className = node.className.trim() ) {
                classNames = className.split( /\s\s*/ );
                classNames.sort();
                path += '.';
                path += classNames.join( '.' );
            }
            if ( dir = node.dir ) {
                path += '[dir=' + dir + ']';
            }
        }
    }
    return path;
}

function getLength ( node ) {
    var nodeType = node.nodeType;
    return nodeType === ELEMENT_NODE ?
        node.childNodes.length : node.length || 0;
}

function detach ( node ) {
    var parent = node.parentNode;
    if ( parent ) {
        parent.removeChild( node );
    }
    return node;
}
function replaceWith ( node, node2 ) {
    var parent = node.parentNode;
    if ( parent ) {
        parent.replaceChild( node2, node );
    }
}
function empty ( node ) {
    var frag = node.ownerDocument.createDocumentFragment(),
        childNodes = node.childNodes,
        l = childNodes ? childNodes.length : 0;
    while ( l-- ) {
        frag.appendChild( node.firstChild );
    }
    return frag;
}

function createElement ( doc, tag, props, children ) {
    var el = doc.createElement( tag ),
        attr, value, i, l;
    if ( props instanceof Array ) {
        children = props;
        props = null;
    }
    if ( props ) {
        for ( attr in props ) {
            value = props[ attr ];
            if ( value !== undefined ) {
                el.setAttribute( attr, props[ attr ] );
            }
        }
    }
    if ( children ) {
        for ( i = 0, l = children.length; i < l; i += 1 ) {
            el.appendChild( children[i] );
        }
    }
    return el;
}

function fixCursor ( node, root ) {
    // In Webkit and Gecko, block level elements are collapsed and
    // unfocussable if they have no content. To remedy this, a <BR> must be
    // inserted. In Opera and IE, we just need a textnode in order for the
    // cursor to appear.
    var doc = node.ownerDocument,
        originalNode = node,
        fixer, child;

    if ( node === root ) {
        if ( !( child = node.firstChild ) || child.nodeName === 'BR' ) {
            fixer = getSquireInstance( doc ).createDefaultBlock();
            if ( child ) {
                node.replaceChild( fixer, child );
            }
            else {
                node.appendChild( fixer );
            }
            node = fixer;
            fixer = null;
        }
    }

    if ( node.nodeType === TEXT_NODE ) {
        return originalNode;
    }
    if ( node.parentNode && !node.isContentEditable ) {
        return originalNode;
    }

    if ( isInline( node ) ) {
        child = node.firstChild;
        while ( cantFocusEmptyTextNodes && child &&
                child.nodeType === TEXT_NODE && !child.data ) {
            node.removeChild( child );
            child = node.firstChild;
        }
        if ( !child ) {
            if ( cantFocusEmptyTextNodes ) {
                fixer = doc.createTextNode( ZWS );
                getSquireInstance( doc )._didAddZWS();
            } else {
                fixer = doc.createTextNode( '' );
            }
        }
    } else {
        if ( useTextFixer ) {
            while ( node.nodeType !== TEXT_NODE && !isLeaf( node ) ) {
                child = node.firstChild;
                if ( !child ) {
                    fixer = doc.createTextNode( '' );
                    break;
                }
                node = child;
            }
            if ( node.nodeType === TEXT_NODE ) {
                // Opera will collapse the block element if it contains
                // just spaces (but not if it contains no data at all).
                if ( /^ +$/.test( node.data ) ) {
                    node.data = '';
                }
            } else if ( isLeaf( node ) ) {
                node.parentNode.insertBefore( doc.createTextNode( '' ), node );
            }
        }
        else if ( isBlock(node) && node.lastChild && node.lastChild.nodeName !== 'BR' ) {
            fixer = createElement( doc, 'BR' );
        }
        else if ( !node.querySelector( 'BR' ) ) {
            fixer = createElement( doc, 'BR' );
            while ( ( child = node.lastElementChild ) && !isInline( child ) ) {
                node = child;
            }
        }
    }
    if ( fixer ) {
        try {
            node.appendChild( fixer );
        } catch ( error ) {
            getSquireInstance( doc ).didError({
                name: 'Squire: fixCursor – ' + error,
                message: 'Parent: ' + node.nodeName + '/' + node.innerHTML +
                    ' appendChild: ' + fixer.nodeName
            });
        }
    }

    return originalNode;
}

/**
 * Ensures a node only contains a single paragraph.
 * The paragraph itself is not checked for correctness. This is fixed later with fixParagraph() from fixContainer()
 *
 * @param {Element} node - The element which should only contain a single P node.
 * @param {Document} doc
 * @param {Object} config - The squire config
 */
function fixChildrenToSingleParagraph( node, doc, config ) {
    var p, child, next;

    if (isParagraph(node.firstChild)) {
        p = node.firstChild;
    } else {
        p = createElement( doc, config.blockTag, config.blockAttributes );
        node.insertBefore(p, node.firstChild);
    }

    var child = p.nextSibling;

    while (child) {
        next = child.nextSibling;
        if (isInline(child)) {
            p.appendChild( child );
        } else if ( child.nodeType === ELEMENT_NODE ) {
            detach( child );
            p.appendChild( empty( child ) );
        }

        child = next;
    }
}

function fixParagraph( node, parent, squire, doc ) {
    if ( parent.nodeName === 'LI' ) {
        //Use UL/OL as parent for validity checks
        parent = parent.parentNode;
    }

    var smwParent = squire._translateToSmw[ getFullNodeName( parent ) ];

    fixInlines( node, smwParent, squire, true);
    // Ensure the paragraph is focusable
    fixCursor( node, squire._root );
}

function fixInlines( node, smwParent, squire, isFirstCascadingChild ) {
    var child = node.firstChild;
    var detachChild, smwChild;

    while ( child ) {
        detachChild = false;
        if (child.nodeType === ELEMENT_NODE) {
            smwChild = squire._translateToSmw[ child.nodeName ];

            if ( !smwChild || !isInline( child ) || ( smwParent && !isInlineAllowedIn( smwChild, smwParent, squire ) ) ) {
                if (!isLeaf(child)) {
                    node.insertBefore( empty( child ), child.nextSibling);
                }
                detachChild = true;

            } else if ( !isLeaf( child ) ){
                // Remove any nested inlines
                var innerSameInlines = child.querySelectorAll(child.nodeName);

                for( var j = 0; j < innerSameInlines.length; j++ ) {
                    var sameInline = innerSameInlines[ j ];
                    sameInline.parentNode.insertBefore( empty( sameInline ), sameInline);
                    detach( sameInline );
                }
                fixInlines( child, smwParent, squire, isFirstCascadingChild && child === node.firstChild );

            } else if ( isFirstCascadingChild && child === node.firstChild  && child.nodeName === 'BR') {
                // Dont allow paragraphs to start with BR
                detachChild = true;
            }
        } else if (child.nodeType === TEXT_NODE) {
            // Merge adjacent textnodes
            var previousSibling = child.previousSibling;
            if (previousSibling && previousSibling.nodeType === TEXT_NODE) {
                previousSibling.data += child.data;
                detach( child );
                child = previousSibling;
            }
        }

        var next = child.nextSibling;
        if (detachChild) {
            detach( child );
        }
        child = next;
    }
}


function getNodeIndex(child) {
    var i = 0;
    while( (child = child.previousSibling) != null ) {
        i++;
    }

    return i;
}

/**
 * Check if a node is allowed in the specified container
 *
 * @param {Element} node
 * @param {Element} container
 * @param {Squire} squire
 * @returns {Boolean|RegExp}
 */
function isBlockAllowedIn( node, container, squire ) {
    if ( isListItem( node ) ) {
        return isList( container );
    } else if ( isParagraph( node ) ) {
        var classification = getSmwClassification( container, squire );
        return classification === 'containers' || classification === 'blockWithText';
    } else {
        var smwNode = squire._translateToSmw[ getFullNodeName( node ) ];
        if (!smwNode) {
            // FIXME: page-break should map to P.page-break-container, not IMG.page-break
            if ( isPagebreak(node) ) {
                smwNode = 'hr';
            } else if ( isWidget(node) ) {
                smwNode = 'smwWidget';
            } else {
                return false;
            }
        }
        var smwContainer = squire._translateToSmw[ getFullNodeName( container ) ];
        var containerTag = smwContainer || container.nodeName.toLowerCase();
        var allowed = squire._allowedBlocksForContainers[ containerTag ];
        return allowed && allowed.indexOf( smwNode ) !== -1;
    } 
}

function isInlineAllowedIn( smwNode, smwBlockContainer, squire ) {
    var allowed = squire._allowedInlineContentForBlocks[ smwBlockContainer ];
    return allowed && allowed.indexOf( smwNode ) !== -1;
}

function getFullNodeName( node ) {
    var c;
    if ( !node || node.nodeType !== ELEMENT_NODE ) {
        return '';
    } else if ( c = node.getAttribute( 'class' ) ){
        return node.nodeName + '.' + c;
    } else {
        return node.nodeName;
    }
}

// Recursively examine container nodes and wrap any inline children.
function fixContainer ( container, root ) {

    if ( !container.isContentEditable ) {
        return;
    }

    var children = container.childNodes,
        doc = container.ownerDocument,
        squire = getSquireInstance( doc ),
        config = squire._config,
        containerClassification = getSmwClassification(container, squire),
        wrapper, finalWrapper, i, l, child, isBR, childClassification;

    if (containerClassification === 'blockWithText' && !isList(container)) {
        fixChildrenToSingleParagraph( container, doc, config );
    }

    for ( i = 0, l = children.length; i < l; i += 1 ) {
        child = children[i];
        isBR = child.nodeName === 'BR';
        if ( !isBR && isInline( child ) ) {
            if ( !wrapper ) {
                 wrapper = createElement( doc, config.blockTag, config.blockAttributes );
            }
            wrapper.appendChild( child );
            i -= 1;
            l -= 1;
        } else if ( isBR || wrapper ) {
            if ( !wrapper ) {
                wrapper = createElement( doc, config.blockTag, config.blockAttributes );
            }

            if ( isList(container) ) {
                finalWrapper = createElement( doc, 'LI', [wrapper] );
            } else {
                finalWrapper = wrapper;
            }

            if ( isBR ) {
                container.replaceChild( finalWrapper, child );
            } else {
                container.insertBefore( finalWrapper, child );
                i += 1;
                l += 1;
            }

            // No need to check the possible li with fixContainer, we created all content here so we know it's right!
            fixParagraph( wrapper, container, squire, doc );
            wrapper = finalWrapper = null;

        } else {
            childClassification = getSmwClassification( child, squire );
            
            if ( isBlockAllowedIn( child , container, squire ) ) {
                if (childClassification !== 'paragraph' && fixStaticBlocks( child, squire, doc, config ) ) {
                    i += 1;
                    l += 1;
                }

                switch (childClassification) {
                    case 'containers':
                    case 'blockWithText':
                        fixContainer( child, root );
                        break;

                    case 'paragraph':
                        fixParagraph( child, container, squire, doc );
                        break;
                }

            } else { // Block not allowed here! remove or unwind
                if (childClassification === 'blockAtomic' || (child.nodeType !== ELEMENT_NODE && child.nodeType !== TEXT_NODE) || !/\S/.test(child.textContent)) {
                    detach( child );
                    i -= 1;
                    l -= 1;
                } else {
                    // Force it to paragraph and use fixParagraph do unwind its content to pure inline content
                    wrapper = createElement( doc, config.blockTag, config.blockAttributes );
                    if ( isList(container) ) {
                        finalWrapper = createElement( doc, 'LI', [wrapper] );
                    } else {
                        finalWrapper = wrapper;
                    }

                    container.replaceChild( finalWrapper, child );
                    wrapper.appendChild(child);
                    fixParagraph( wrapper, container, squire, doc );
                    
                    wrapper = finalWrapper = null;
                }
            }
        }
    }

    if ( wrapper ) {
        if ( isList(container) ) {
            finalWrapper = createElement( doc, 'LI', [wrapper] );
        } else {
            finalWrapper = wrapper;
        }
        container.appendChild( finalWrapper );
        fixParagraph( wrapper, container, squire, doc );
    }

    if ( containerClassification === 'containers' ) {
        squire._ensureBottomLine( container );
    }

    return container;
}

function fixStaticBlocks( node, squire, doc, config ) {
    var classification = getSmwClassification( node, squire );
    var nodeInsertedBefore = false;
    var isStatic = classification === 'blockAtomic' || classification === 'containers'; 

    if ( isStatic || isBlockquote(node) || isList(node)) {
        var previous = node.previousSibling || node.parentNode;
        var prevClassification = getSmwClassification( previous, squire );
        switch ( prevClassification ) {
            case 'blockAtomic':
            case 'containers':
                //insert between static nodes
                var defaultBlock = fixCursor( createElement( doc, config.blockTag, config.blockAttributes ), squire._root );
                node.parentNode.insertBefore( defaultBlock, node );
                nodeInsertedBefore = true;
                break;
        } 
    }
    return nodeInsertedBefore;
}

/**
 * Returns the SMW classification for a node.
 * The following classifications exists for squire container nodes:
 * - 'containers'
 * - 'blockWithText'
 * - 'blockAtomic'
 *
 * @param {Element} node
 * @param {Squire} squire
 * @returns {String|undefined} The classification string or undefined if node does not have any classification
 */
function getSmwClassification( node, squire ) {
    var classification;
    if (node === squire._root) {
        classification = squire._inlineMode ? 'blockWithText' : 'containers';
    } else if (isParagraph(node)) {
        classification = 'paragraph';
    } else if (isListItem(node)) {
        classification = 'blockWithText';
    } else if (isPagebreak(node) || isWidget(node)) {
        // FIXME: HR should be mapped with P.page-break-container so we dont need this extra check
        classification = 'blockAtomic';
    } else {
        var name = getFullNodeName( node );
        var smwNode = squire._translateToSmw[ name ];
        classification = squire._allowedContent[ smwNode ];
    }
    return classification;

}

function split ( node, offset, stopNode, root ) {
    var nodeType = node.nodeType,
        parent, clone, next;
    if ( nodeType === TEXT_NODE && node !== stopNode ) {
        return split(
            node.parentNode, node.splitText( offset ), stopNode, root );
    }
    if ( nodeType === ELEMENT_NODE ) {
        if ( typeof( offset ) === 'number' ) {
            offset = offset < node.childNodes.length ?
                node.childNodes[ offset ] : null;
        }
        if ( node === stopNode ) {
            return offset;
        }

        // Clone node without children
        parent = node.parentNode;
        clone = node.cloneNode( false );

        // Add right-hand siblings to the clone
        while ( offset ) {
            next = offset.nextSibling;
            clone.appendChild( offset );
            offset = next;
        }

        // Maintain li numbering if inside a quote.
        if ( node.nodeName === 'OL' &&
                getNearest( node, root, 'BLOCKQUOTE' ) ) {
            clone.start = ( +node.start || 1 ) + node.childNodes.length - 1;
        }

        // DO NOT NORMALISE. This may undo the fixCursor() call
        // of a node lower down the tree!

        // We need something in the element in order for the cursor to appear.
        fixCursor( node, root );
        fixCursor( clone, root );

        // Inject clone after original node
        if ( next = node.nextSibling ) {
            parent.insertBefore( clone, next );
        } else {
            parent.appendChild( clone );
        }

        // Keep on splitting up the tree
        return split( parent, clone, stopNode, root );
    }
    return offset;
}

function _mergeInlines ( node, fakeRange ) {
    if ( node.nodeType !== ELEMENT_NODE ) {
        return;
    }
    var children = node.childNodes,
        l = children.length,
        frags = [],
        child, prev, len;
    while ( l-- ) {
        child = children[l];
        prev = l && children[ l - 1 ];
        if ( l && isInline( child ) && areAlike( child, prev ) &&
                !leafNodeNames[ child.nodeName ] ) {
            if ( fakeRange.startContainer === child ) {
                fakeRange.startContainer = prev;
                fakeRange.startOffset += getLength( prev );
            }
            if ( fakeRange.endContainer === child ) {
                fakeRange.endContainer = prev;
                fakeRange.endOffset += getLength( prev );
            }
            if ( fakeRange.startContainer === node ) {
                if ( fakeRange.startOffset > l ) {
                    fakeRange.startOffset -= 1;
                }
                else if ( fakeRange.startOffset === l ) {
                    fakeRange.startContainer = prev;
                    fakeRange.startOffset = getLength( prev );
                }
            }
            if ( fakeRange.endContainer === node ) {
                if ( fakeRange.endOffset > l ) {
                    fakeRange.endOffset -= 1;
                }
                else if ( fakeRange.endOffset === l ) {
                    fakeRange.endContainer = prev;
                    fakeRange.endOffset = getLength( prev );
                }
            }
            detach( child );
            if ( child.nodeType === TEXT_NODE ) {
                prev.appendData( child.data );
            }
            else {
                frags.push( empty( child ) );
            }
        }
        else if ( child.nodeType === ELEMENT_NODE ) {
            len = frags.length;
            while ( len-- ) {
                child.appendChild( frags.pop() );
            }
            _mergeInlines( child, fakeRange );
        }
    }
}

function mergeInlines ( node, range ) {
    if ( node.nodeType === TEXT_NODE ) {
        node = node.parentNode;
    }
    if ( node.nodeType === ELEMENT_NODE ) {
        var fakeRange = {
            startContainer: range.startContainer,
            startOffset: range.startOffset,
            endContainer: range.endContainer,
            endOffset: range.endOffset
        };
        _mergeInlines( node, fakeRange );
        range.setStart( fakeRange.startContainer, fakeRange.startOffset );
        range.setEnd( fakeRange.endContainer, fakeRange.endOffset );
    }
}

function mergeWithBlock ( block, next, range ) {
    var container = next,
        last, offset, _range;
    while ( container.parentNode.childNodes.length === 1 ) {
        container = container.parentNode;
    }
    detach( container );
    block.normalize();
    offset = block.childNodes.length;

    // Remove extra <BR> fixer if present.
    last = block.lastChild;
    if ( last && last.nodeName === 'BR' ) {
        block.removeChild( last );
        offset -= 1;
    }

    _range = {
        startContainer: block,
        startOffset: offset,
        endContainer: block,
        endOffset: offset
    };

    block.appendChild( empty( next ) );
    _mergeInlines( block, _range );

    range.setStart( _range.startContainer, _range.startOffset );
    range.collapse( true );

    // Opera inserts a BR if you delete the last piece of text
    // in a block-level element. Unfortunately, it then gets
    // confused when setting the selection subsequently and
    // refuses to accept the range that finishes just before the
    // BR. Removing the BR fixes the bug.
    // Steps to reproduce bug: Type "a-b-c" (where - is return)
    // then backspace twice. The cursor goes to the top instead
    // of after "b".
    if ( isPresto && ( last = block.lastChild ) && last.nodeName === 'BR' ) {
        block.removeChild( last );
    }
}

function mergeContainers ( node, root ) {
    var prev = node.previousSibling,
        first = node.firstChild,
        doc = node.ownerDocument,
        isListItem = ( node.nodeName === 'LI' ),
        needsFix, block;

    // Do not merge LIs, unless it only contains a UL ... and don't merge headers
    if ( isListItem && ( !first || !/^[OU]L$/.test( first.nodeName ) ) || node.nodeName[0] === 'H') {
        return;
    }

    if ( prev && areAlike( prev, node ) ) {
        if ( !isContainer( prev ) ) {
            if ( isListItem ) {
                block = createElement( doc, 'DIV' );
                block.appendChild( empty( prev ) );
                prev.appendChild( block );
            } else {
                return;
            }
        }
        detach( node );
        needsFix = !isContainer( node );
        prev.appendChild( empty( node ) );
        if ( needsFix ) {
            fixContainer( prev, root );
        }
        if ( first ) {
            mergeContainers( first, root );
        }
    } else if ( isListItem ) {
        prev = createElement( doc, 'DIV' );
        node.insertBefore( prev, first );
        fixCursor( prev, root );
    }
}

var getNodeBefore = function ( node, offset ) {
    var children = node.childNodes;
    while ( offset && node.nodeType === ELEMENT_NODE ) {
        node = children[ offset - 1 ];
        children = node.childNodes;
        offset = children.length;
    }
    return node;
};

var getNodeAfter = function ( node, offset ) {
    if ( node.nodeType === ELEMENT_NODE ) {
        var children = node.childNodes;
        if ( offset < children.length ) {
            node = children[ offset ];
        } else {
            while ( node && !node.nextSibling ) {
                node = node.parentNode;
            }
            if ( node ) { node = node.nextSibling; }
        }
    }
    return node;
};

var expandWord = function ( range ) {
    if ( range.collapsed && range.startContainer.nodeType === TEXT_NODE) {
        var text = range.startContainer.textContent;
        var wordRe = /\S+/g;
        var match;
        while ( (match = wordRe.exec( text )) !== null ) {
            var wordStart = match.index;
            var wordEnd = match.index + match[0].length;
            if ( wordStart < range.startOffset && wordEnd > range.startOffset ) {
                range.setStart( range.startContainer, wordStart );
                range.setEnd( range.startContainer, wordEnd );
                break;
            }
        }
    }
    //No words in start node of range
    return range;
};

// ---

var insertNodeInRange = function ( range, node ) {
    // Insert at start.
    var startContainer = range.startContainer,
        startOffset = range.startOffset,
        endContainer = range.endContainer,
        endOffset = range.endOffset,
        parent, children, childCount, afterSplit;

    // If part way through a text node, split it.
    if ( startContainer.nodeType === TEXT_NODE ) {
        parent = startContainer.parentNode;
        children = parent.childNodes;
        if ( startOffset === startContainer.length ) {
            startOffset = indexOf.call( children, startContainer ) + 1;
            if ( range.collapsed ) {
                endContainer = parent;
                endOffset = startOffset;
            }
        } else {
            if ( startOffset ) {
                afterSplit = startContainer.splitText( startOffset );
                if ( endContainer === startContainer ) {
                    endOffset -= startOffset;
                    endContainer = afterSplit;
                }
                else if ( endContainer === parent ) {
                    endOffset += 1;
                }
                startContainer = afterSplit;
            }
            startOffset = indexOf.call( children, startContainer );
        }
        startContainer = parent;
    } else {
        children = startContainer.childNodes;
    }

    childCount = children.length;

    if ( startOffset === childCount ) {
        startContainer.appendChild( node );
    } else {
        startContainer.insertBefore( node, children[ startOffset ] );
    }

    if ( startContainer === endContainer ) {
        endOffset += children.length - childCount;
    }

    range.setStart( startContainer, startOffset );
    range.setEnd( endContainer, endOffset );
};

var extractContentsOfRange = function ( range, common, root, parentPattern ) {
    var startContainer = range.startContainer,
        startOffset = range.startOffset,
        endContainer = range.endContainer,
        endOffset = range.endOffset;

    if ( !common ) {
        common = range.commonAncestorContainer;
    }

    if ( common.nodeType === TEXT_NODE ) {
        common = common.parentNode;
    }

    var endNode = parentPattern != undefined && new RegExp( parentPattern ).test( endContainer.nodeName ) ? endContainer : split( endContainer, endOffset, common, root ),
        startNode = parentPattern != undefined && new RegExp( parentPattern ).test( startContainer.nodeName ) ? startContainer : split( startContainer, startOffset, common, root ),
        frag = common.ownerDocument.createDocumentFragment(),
        next, before, after;

    if ( startNode === endNode && parentPattern != undefined && new RegExp( parentPattern ).test( startNode.nodeName ) ) {
        frag.appendChild(startNode);
        return frag;
    }
    // End node will be null if at end of child nodes list.
    while ( startNode !== endNode ) {
        next = startNode.nextSibling;
        frag.appendChild( startNode );
        startNode = next;
    }

    startContainer = common;
    startOffset = endNode ?
        indexOf.call( common.childNodes, endNode ) :
        common.childNodes.length;

    // Merge text nodes if adjacent. IE10 in particular will not focus
    // between two text nodes
    after = common.childNodes[ startOffset ];
    before = after && after.previousSibling;
    if ( before &&
            before.nodeType === TEXT_NODE &&
            after.nodeType === TEXT_NODE ) {
        startContainer = before;
        startOffset = before.length;
        before.appendData( after.data );
        detach( after );
    }

    range.setStart( startContainer, startOffset );
    range.collapse( true );

    fixCursor( common, root );

    return frag;
};

var encapsulateNonEditableElements = function ( range, root ) {
    var startNode = range.startContainer;
    var endNode = range.endContainer;
    // Ensure range encapsulates contenteditable=false elements
    while ( startNode && startNode !== root ) {
        if ( startNode.nodeType !== TEXT_NODE && !startNode.isContentEditable) {
            range.setStartBefore(startNode);
        }
        startNode = startNode.parentNode;
    }

    while ( endNode && endNode !== root) {
        if ( endNode.nodeType !== TEXT_NODE && !endNode.isContentEditable) {
            range.setEndAfter(endNode);
        }
        endNode = endNode.parentNode;
    }
}


var deleteContentsOfRange = function ( range, root, skipEncapsulateNonEditables ) {
    if (!skipEncapsulateNonEditables) {
        encapsulateNonEditableElements(range, root);
    }
    // Move boundaries up as much as possible to reduce need to split.
    // But we need to check whether we've moved the boundary outside of a
    // block. If so, the entire block will be removed, so we shouldn't merge
    // later.
    moveRangeBoundariesUpTree( range );

    var startBlock = range.startContainer,
        endBlock = range.endContainer,
        needsMerge = ( isInline( startBlock ) || isBlock( startBlock ) ) &&
            ( isInline( endBlock ) || isBlock( endBlock ) );

    // Remove selected range
    var frag = extractContentsOfRange( range, null, root );

    // Move boundaries back down tree so that they are inside the blocks.
    // If we don't do this, the range may be collapsed to a point between
    // two blocks, so get(Start|End)BlockOfRange will return null.
    moveRangeBoundariesDownTree( range );

    // If we split into two different blocks, merge the blocks.
    startBlock = getStartBlockOfRange( range, root );
    if ( needsMerge ) {
        endBlock = getEndBlockOfRange( range, root );
        if ( startBlock && endBlock && startBlock !== endBlock ) {
            mergeWithBlock( startBlock, endBlock, range );
        }
    }

    // Ensure block has necessary children
    if ( startBlock ) {
        fixCursor( startBlock, root );
    }

    // Ensure root has a block-level element in it.
    var child = root.firstChild;
    if ( !child || child.nodeName === 'BR' ) {
        fixCursor( root, root );
        range.selectNodeContents( root.firstChild );
    } else {
        range.collapse( false );
    }
    return frag;
};

// ---

var insertTreeFragmentIntoRange = function ( range, frag, root ) {
    // Check if it's all inline content
    var allInline = true,
        children = frag.childNodes,
        l = children.length;
    while ( l-- ) {
        if ( !isInline( children[l] ) ) {
            allInline = false;
            break;
        }
    }

    // Delete any selected content
    if ( !range.collapsed ) {
        deleteContentsOfRange( range, root );
    }

    // Move range down into text nodes
    moveRangeBoundariesDownTree( range );

    if ( allInline ) {
        // If inline, just insert at the current position.
        insertNodeInRange( range, frag );
        range.collapse( false );
    } else {
        // Otherwise...
        // 1. Split up to blockquote (if a parent) or root
        var splitPoint = range.startContainer,
            nodeAfterSplit = split(
                splitPoint,
                range.startOffset,
                getNearest( splitPoint.parentNode, root, 'BLOCKQUOTE' ) || root,
                root
            ),
            nodeBeforeSplit = nodeAfterSplit.previousSibling,
            startContainer = nodeBeforeSplit,
            startOffset = startContainer.childNodes.length,
            endContainer = nodeAfterSplit,
            endOffset = 0,
            parent = nodeAfterSplit.parentNode,
            child, node, prev, next, startAnchor;

        // 2. Move down into edge either side of split and insert any inline
        // nodes at the beginning/end of the fragment
        while ( ( child = startContainer.lastChild ) &&
                child.nodeType === ELEMENT_NODE ) {
            if ( child.nodeName === 'BR' ) {
                startOffset -= 1;
                break;
            }
            startContainer = child;
            startOffset = startContainer.childNodes.length;
        }
        while ( ( child = endContainer.firstChild ) &&
                child.nodeType === ELEMENT_NODE &&
                child.nodeName !== 'BR' ) {
            endContainer = child;
        }
        startAnchor = startContainer.childNodes[ startOffset ] || null;
        while ( ( child = frag.firstChild ) && isInline( child ) ) {
            startContainer.insertBefore( child, startAnchor );
        }
        while ( ( child = frag.lastChild ) && isInline( child ) ) {
            endContainer.insertBefore( child, endContainer.firstChild );
            endOffset += 1;
        }

        // 3. Fix cursor then insert block(s) in the fragment
        node = frag;
        // We run fixContainer later instead to not mess with contenteditable=false elements
//        while ( node = getNextBlock( node, root ) ) {
//            fixCursor( node, root );
//        }
        parent.insertBefore( frag, nodeAfterSplit );

        // 4. Remove empty nodes created either side of split, then
        // merge containers at the edges.
        next = nodeBeforeSplit.nextSibling;
        node = getPreviousBlock( next, root );
        if ( node && !/\S/.test( node.textContent ) ) {
            do {
                parent = node.parentNode;
                parent.removeChild( node );
                node = parent;
            } while ( node && !node.lastChild && node !== root );
        }
        if ( !nodeBeforeSplit.parentNode ) {
            nodeBeforeSplit = next.previousSibling;
        }
        if ( !startContainer.parentNode ) {
            startContainer = nodeBeforeSplit || next.parentNode;
            startOffset = nodeBeforeSplit ?
                nodeBeforeSplit.childNodes.length : 0;
        }
        // Merge inserted containers with edges of split
        if ( isContainer( next ) && next.isContentEditable ) {
            mergeContainers( next, root );
        }

        prev = nodeAfterSplit.previousSibling;
        node = isBlock( nodeAfterSplit ) ?
            nodeAfterSplit : getNextBlock( nodeAfterSplit, root );
        if ( node && !/\S/.test( node.textContent ) ) {
            do {
                parent = node.parentNode;
                parent.removeChild( node );
                node = parent;
            } while ( node && !node.lastChild && node !== root );
        }
        if ( !nodeAfterSplit.parentNode ) {
            nodeAfterSplit = prev.nextSibling;
        }
        if ( !endOffset ) {
            endContainer = prev;
            endOffset = prev.childNodes.length;
        }
        // Merge inserted containers with edges of split
        if ( nodeAfterSplit && isContainer( nodeAfterSplit ) && nodeAfterSplit.isContentEditable ) {
            mergeContainers( nodeAfterSplit, root );
        }

        range.setStart( startContainer, startOffset );
        range.setEnd( endContainer, endOffset );
        encapsulateNonEditableElements(range, root);
        moveRangeBoundariesDownTree( range );
    }
};

// ---

var isNodeContainedInRange = function ( range, node, partial ) {
    var nodeRange = node.ownerDocument.createRange();

    nodeRange.selectNode( node );

    if ( partial ) {
        // Node must not finish before range starts or start after range
        // finishes.
        var nodeEndBeforeStart = ( range.compareBoundaryPoints(
                END_TO_START, nodeRange ) > -1 ),
            nodeStartAfterEnd = ( range.compareBoundaryPoints(
                START_TO_END, nodeRange ) < 1 );
        return ( !nodeEndBeforeStart && !nodeStartAfterEnd );
    }
    else {
        // Node must start after range starts and finish before range
        // finishes
        var nodeStartAfterStart = ( range.compareBoundaryPoints(
                START_TO_START, nodeRange ) < 1 ),
            nodeEndBeforeEnd = ( range.compareBoundaryPoints(
                END_TO_END, nodeRange ) > -1 );
        return ( nodeStartAfterStart && nodeEndBeforeEnd );
    }
};

var moveRangeBoundariesDownTree = function ( range ) {
    var startContainer = range.startContainer,
        startOffset = range.startOffset,
        endContainer = range.endContainer,
        endOffset = range.endOffset,
        child;

    while ( startContainer.nodeType !== TEXT_NODE ) {
        child = startContainer.childNodes[ startOffset ];
        if ( !child || isLeaf( child ) || !child.isContentEditable) {
            break;
        }
        startContainer = child;
        startOffset = 0;
    }
    if ( endOffset ) {
        while ( endContainer.nodeType !== TEXT_NODE ) {
            child = endContainer.childNodes[ endOffset - 1 ];
            if ( !child || isLeaf( child ) || !child.isContentEditable) {
                break;
            }
            endContainer = child;
            endOffset = getLength( endContainer );
        }
    } else {
        while ( endContainer.nodeType !== TEXT_NODE ) {
            child = endContainer.firstChild;
            if ( !child || isLeaf( child ) || !child.isContentEditable) {
                break;
            }
            endContainer = child;
        }
    }

    // If collapsed, this algorithm finds the nearest text node positions
    // *outside* the range rather than inside, but also it flips which is
    // assigned to which.
    if ( range.collapsed ) {
        range.setStart( endContainer, endOffset );
        range.setEnd( startContainer, startOffset );
    } else {
        range.setStart( startContainer, startOffset );
        range.setEnd( endContainer, endOffset );
    }
};

var moveRangeBoundariesUpTree = function ( range, common ) {
    var startContainer = range.startContainer,
        startOffset = range.startOffset,
        endContainer = range.endContainer,
        endOffset = range.endOffset,
        parent;

    if ( !common ) {
        common = range.commonAncestorContainer;
    }

    while ( startContainer !== common && !startOffset ) {
        parent = startContainer.parentNode;
        startOffset = indexOf.call( parent.childNodes, startContainer );
        startContainer = parent;
    }

    while ( endContainer !== common &&
            endOffset === getLength( endContainer ) ) {
        parent = endContainer.parentNode;
        endOffset = indexOf.call( parent.childNodes, endContainer ) + 1;
        endContainer = parent;
    }

    range.setStart( startContainer, startOffset );
    range.setEnd( endContainer, endOffset );
};

// Returns the first block at least partially contained by the range,
// or null if no block is contained by the range.
var getStartBlockOfRange = function ( range, root ) {
    var container = range.startContainer,
        block;

    // If inline, get the containing block.
    if ( isInline( container ) ) {
        block = getPreviousBlock( container, root );
    } else if ( isBlock( container ) ) {
        block = container;
    } else {
        block = getNodeBefore( container, range.startOffset );
        block = getNextBlock( block, root );
    }
    // Check the block actually intersects the range
    return block && isNodeContainedInRange( range, block, true ) ? block : null;
};

// Returns the last block at least partially contained by the range,
// or null if no block is contained by the range.
var getEndBlockOfRange = function ( range, root ) {
    var container = range.endContainer,
        block, child;

    // If inline, get the containing block.
    if ( isInline( container ) ) {
        block = getPreviousBlock( container, root );
    } else if ( isBlock( container ) ) {
        block = container;
    } else {
        block = getNodeAfter( container, range.endOffset );
        if ( !block ) {
            block = root;
            while ( child = block.lastChild ) {
                block = child;
            }
        }
        block = getPreviousBlock( block, root );
    }
    // Check the block actually intersects the range
    return block && isNodeContainedInRange( range, block, true ) ? block : null;
};

var contentWalker = new TreeWalker( null,
    SHOW_TEXT|SHOW_ELEMENT,
    function ( node ) {
        return node.nodeType === TEXT_NODE ?
            notWS.test( node.data ) :
            node.nodeName === 'IMG';
    }
);

var rangeDoesStartAtBlockBoundary = function ( range, root ) {
    var startContainer = range.startContainer,
        startOffset = range.startOffset;

    // If in the middle or end of a text node, we're not at the boundary.
    contentWalker.root = null;
    if ( startContainer.nodeType === TEXT_NODE ) {
        if ( startOffset ) {
            return false;
        }
        contentWalker.currentNode = startContainer;
    } else {
        contentWalker.currentNode = getNodeAfter( startContainer, startOffset );
    }

    // Otherwise, look for any previous content in the same block.
    contentWalker.root = getStartBlockOfRange( range, root );

    return !contentWalker.previousNode();
};

var rangeDoesEndAtBlockBoundary = function ( range, root ) {
    var endContainer = range.endContainer,
        endOffset = range.endOffset,
        length;

    // If in a text node with content, and not at the end, we're not
    // at the boundary
    contentWalker.root = null;
    if ( endContainer.nodeType === TEXT_NODE ) {
        length = endContainer.data.length;
        if ( length && endOffset < length ) {
            return false;
        }
        contentWalker.currentNode = endContainer;
    } else {
        contentWalker.currentNode = getNodeBefore( endContainer, endOffset );
    }

    // Otherwise, look for any further content in the same block.
    contentWalker.root = getEndBlockOfRange( range, root );

    return !contentWalker.nextNode();
};

var expandRangeToBlockBoundaries = function ( range, root ) {
    var node = range.commonAncestorContainer;
    var untouchableNode = null;
    var start, end, parent;

    while ( node && node !== root ) {
        if ( node.getAttribute('contenteditable') === 'false' || !node.isContentEditable) {
            untouchableNode = node;
        }
        node = node.parentNode;
    }

    if (untouchableNode) {
        start = untouchableNode;
        end = untouchableNode;
    } else {
        start = getStartBlockOfRange( range, root );
        end = getEndBlockOfRange( range, root );
    }


    if ( start && end ) {
        parent = start.parentNode;
        range.setStart( parent, indexOf.call( parent.childNodes, start ) );
        parent = end.parentNode;
        range.setEnd( parent, indexOf.call( parent.childNodes, end ) + 1 );
    }
};

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
        
        if (currentBlock === root || isAside(currentBlock) || isPagePanel(currentBlock)) {
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
                if (currentBlock === root || isAside(currentBlock) || isPagePanel(currentBlock)) {
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
                    if (previous.parentNode === root || isAside(previous.parentNode) || isPagePanel(previous.parentNode)) {
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
            if (current.parentNode === root || isAside(current.parentNode) || isPagePanel(current.parentNode)) {
                currentBlock = current;
                currentContainer = current.parentNode;
            } else {
                currentBlock = current.parentNode;
                currentContainer = currentBlock.parentNode;
            }

            if ( isAside(currentBlock.nextElementSibling ) ||
                isPagePanel(currentBlock.nextElementSibling) ||
                ( currentContainer.lastElementChild === currentBlock && ( !isList(currentContainer) || isAside(currentContainer.nextElementSibling) || isPagePanel(currentContainer.nextElementSibling)) )) {
                // Do not merge if last element of container
            } else if ( next ) {
                var nextBlock;
                if (next.parentNode === root || isAside(next.parentNode) || isPagePanel(current.parentNode)) {
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

var fontSizes = {
    1: 10,
    2: 13,
    3: 16,
    4: 18,
    5: 24,
    6: 32,
    7: 48
};

var spanToSemantic = {
    backgroundColor: {
        regexp: notWS,
        replace: function ( doc, colour ) {
            return createElement( doc, 'SPAN', {
                'class': 'highlight',
                style: 'background-color:' + colour
            });
        }
    },
    color: {
        regexp: notWS,
        replace: function ( doc, colour ) {
            return createElement( doc, 'SPAN', {
                'class': 'colour',
                style: 'color:' + colour
            });
        }
    },
    fontWeight: {
        regexp: /^bold/i,
        replace: function ( doc ) {
            return createElement( doc, 'B' );
        }
    },
    fontStyle: {
        regexp: /^italic/i,
        replace: function ( doc ) {
            return createElement( doc, 'I' );
        }
    },
    fontFamily: {
        regexp: notWS,
        replace: function ( doc, family ) {
            return createElement( doc, 'SPAN', {
                'class': 'font',
                style: 'font-family:' + family
            });
        }
    },
    fontSize: {
        regexp: notWS,
        replace: function ( doc, size ) {
            return createElement( doc, 'SPAN', {
                'class': 'size',
                style: 'font-size:' + size
            });
        }
    }
};

var replaceWithTag = function ( tag ) {
    return function ( node, parent ) {
        var el = createElement( node.ownerDocument, tag );
        parent.replaceChild( el, node );
        el.appendChild( empty( node ) );
        return el;
    };
};

var stylesRewriters = {
    SPAN: function ( span, parent ) {
        var text = doc.createTextNode( span.textContent );
        parent.replaceChild( text, span );
        return text;
    },
    STRONG: replaceWithTag( 'B' ),
    EM: replaceWithTag( 'I' ),
    IMG: function ( img, parent, errorCallback ) {
        //TODO: this class is defined in config, plx get from there
        if ( img.className === 'page-break' ) {
            return img;
        } else {
            var p = createElement( doc, 'P', { 'class': 'smw-missing-image' });
            var imageInfo = [ img.src, img.alt, img.title ].filter( function(e){ return e !== undefined || e !== ""; } );
            p.innerHTML = '<br><b>Missing image: ' + imageInfo.join('<br>') + '</b><br>';
            parent.replaceChild( p, img );
            if ( errorCallback ) {
                errorCallback( img );
            }
            return p;
        }
    },
    A: function ( node, parent ) {
        return node;
    },
    LI: function ( node, parent ) {
        var li;
        if ( node.firstChild.nodeName !== 'P' ) {
            var p = createElement( doc, 'P', {}, [ doc.createTextNode(node.textContent) ] );
            li = createElement( doc, 'LI', {}, [p] );
            parent.replaceChild( li, node );
        } else {
            li = node;
        }
        return li;
    },
    BLOCKQUOTE: function( node ) {
        if ( node.className !== 'aside' && node.className !== 'page-panel' ){
            node.className = 'blockquote';
        }
        return node;
    }
};

var allowedBlock = /^(?:A(?:DDRESS|RTICLE|SIDE|UDIO)|BLOCKQUOTE|CAPTION|D(?:[DLT]|IV)|F(?:IGURE|IGCAPTION|OOTER)|H[1-6]|HEADER|L(?:ABEL|EGEND|I)|O(?:L|UTPUT)|P(?:RE)?|SECTION|T(?:ABLE|BODY|D|FOOT|H|HEAD|R)|UL)$/;
var smwAllowedBlock = /^(A|BLOCKQUOTE|H[1-4]|LI|UL|OL|P|ASIDE|MYWO-CONTENT-WIDGET|SMW-CONTENT-WIDGET|DIV|BR)$/;
var unbreakableBlock = /^(MYWO-CONTENT-WIDGET)$/;

var blacklist = /^(?:HEAD|META|STYLE)/;

var walker = new TreeWalker( null, SHOW_TEXT|SHOW_ELEMENT, function () {
    return true;
});

/*
    Two purposes:

    1. Remove nodes we don't want, such as weird <o:p> tags, comment nodes
       and whitespace nodes.
    2. Convert inline tags into our preferred format.
*/
var cleanTree = function cleanTree ( node, preserveWS, errorCallback ) {
    var children = node.childNodes,
        nonInlineParent, i, l, child, nodeName, nodeType, rewriter, childLength,
        startsWithWS, endsWithWS, data, sibling;

    nonInlineParent = node;
    while ( isInline( nonInlineParent ) ) {
        nonInlineParent = nonInlineParent.parentNode;
    }
    walker.root = nonInlineParent;

    for ( i = 0, l = children.length; i < l; i += 1 ) {
        child = children[i];
        nodeName = child.nodeName;
        nodeType = child.nodeType;
        rewriter = stylesRewriters[ nodeName ];
        if ( nodeType === ELEMENT_NODE ) {
            //SMW - remove style
            child.setAttribute('style', '');
            childLength = child.childNodes.length;
            if ( rewriter ) {
                var _child = rewriter( child, node, errorCallback );
                if ( _child ) {
                    child = _child;
                    if ( child.nodeType === TEXT_NODE )
                        childLength = undefined;    
                } else {
                    //Rewriter wants us to remove the child
                    i -= 1;
                    l -= 1;
                    node.removeChild( child );
                    continue;
                }
                
            } else if ( blacklist.test( nodeName ) ) {
                node.removeChild( child );
                i -= 1;
                l -= 1;
                continue;
            } else if ( !smwAllowedBlock.test( nodeName ) && !isInline( child ) ) {
                //i -= 1;
                //l += childLength - 1;
                var textContent = child.textContent || child.innerText;
                node.replaceChild( doc.createTextNode( textContent ) , child );
                if ( errorCallback ) {
                    errorCallback( child );
                }
                continue;
            }
            if ( childLength && !unbreakableBlock.test( nodeName ) ) {
                cleanTree( child, preserveWS || ( nodeName === 'PRE' ), errorCallback );
            }
        } else {
            if ( nodeType === TEXT_NODE ) {
                data = child.data;
                startsWithWS = !notWS.test( data.charAt( 0 ) );
                endsWithWS = !notWS.test( data.charAt( data.length - 1 ) );
                if ( preserveWS || ( !startsWithWS && !endsWithWS ) ) {
                    continue;
                }
                // Iterate through the nodes; if we hit some other content
                // before the start of a new block we don't trim
                if ( startsWithWS ) {
                    walker.currentNode = child;
                    while ( sibling = walker.previousPONode() ) {
                        nodeName = sibling.nodeName;
                        if ( nodeName === 'IMG' ||
                                ( nodeName === '#text' &&
                                    /\S/.test( sibling.data ) ) ) {
                            break;
                        }
                        if ( !isInline( sibling ) ) {
                            sibling = null;
                            break;
                        }
                    }
                    data = data.replace( /^\s+/g, sibling ? ' ' : '' );
                }
                if ( endsWithWS ) {
                    walker.currentNode = child;
                    while ( sibling = walker.nextNode() ) {
                        if ( nodeName === 'IMG' ||
                                ( nodeName === '#text' &&
                                    /\S/.test( sibling.data ) ) ) {
                            break;
                        }
                        if ( !isInline( sibling ) ) {
                            sibling = null;
                            break;
                        }
                    }
                    data = data.replace( /\s+$/g, sibling ? ' ' : '' );
                }
                if ( data ) {
                    child.data = data;
                    continue;
                }
            }
            node.removeChild( child );
            i -= 1;
            l -= 1;
        }
    }
    return node;
};

// ---

var removeEmptyInlines = function removeEmptyInlines ( node ) {
    var children = node.childNodes,
        l = children.length,
        child;
    while ( l-- ) {
        child = children[l];
        if ( child.nodeType === ELEMENT_NODE && !isLeaf( child ) ) {
            removeEmptyInlines( child );
            if ( isInline( child ) && !child.firstChild ) {
                node.removeChild( child );
            }
        } else if ( child.nodeType === TEXT_NODE && !child.data ) {
            node.removeChild( child );
        }
    }
};

// ---

var notWSTextNode = function ( node ) {
    return node.nodeType === ELEMENT_NODE ?
        node.nodeName === 'BR' :
        notWS.test( node.data );
};
var isLineBreak = function ( br ) {
    var block = br.parentNode,
        walker;
    while ( isInline( block ) ) {
        block = block.parentNode;
    }
    walker = new TreeWalker(
        block, SHOW_ELEMENT|SHOW_TEXT, notWSTextNode );
    walker.currentNode = br;
    return !!walker.nextNode();
};

// <br> elements are treated specially, and differently depending on the
// browser, when in rich text editor mode. When adding HTML from external
// sources, we must remove them, replacing the ones that actually affect
// line breaks by wrapping the inline text in a <div>. Browsers that want <br>
// elements at the end of each block will then have them added back in a later
// fixCursor method call.
var cleanupBRs = function ( node, root ) {
    var brs = node.querySelectorAll( 'BR' ),
        brBreaksLine = [],
        l = brs.length,
        i, br, parent;

    // Must calculate whether the <br> breaks a line first, because if we
    // have two <br>s next to each other, after the first one is converted
    // to a block split, the second will be at the end of a block and
    // therefore seem to not be a line break. But in its original context it
    // was, so we should also convert it to a block split.
    for ( i = 0; i < l; i += 1 ) {
        brBreaksLine[i] = isLineBreak( brs[i] );
    }
    while ( l-- ) {
        br = brs[l];
        // Cleanup may have removed it
        parent = br.parentNode;
        if ( !parent ) { continue; }
        // If it doesn't break a line, just remove it; it's not doing
        // anything useful. We'll add it back later if required by the
        // browser. If it breaks a line, wrap the content in div tags
        // and replace the brs.
        if ( !brBreaksLine[l] ) {
            detach( br );
        } else if ( !isInline( parent ) ) {
            // fixContainer( parent, root );
        }
    }
};


var fakeClipboardContent = null;
var FAKECLIPBOARD_CONSTANT = '___MYWO_CLIPBOARD___: ';

/**
 * used on ios to decide if we should clear our fake clipboard or not.
 *
 * @param event
 */
var onVisibilityChange = function( event ) {
    fakeClipboardContent = null;
};

var onCut = function ( event ) {
    var clipboardData = event.clipboardData;
    var range = this.getSelection();
    var node = this.createElement( 'div' );
    var root = this._root;
    var self = this;

    // Save undo checkpoint
    this.saveUndoState( range );

    // Edge only seems to support setting plain text as of 2016-03-11.
    // Mobile Safari flat out doesn't work:
    // https://bugs.webkit.org/show_bug.cgi?id=143776
    if (isEdge) {
        node.appendChild( deleteContentsOfRange( range, root ) );
        fakeClipboardContent = node.innerHTML;
        clipboardData.setData('text/plain', FAKECLIPBOARD_CONSTANT + (node.innerText || node.textContent));
        event.preventDefault();
        fixContainer(root, root);
        this._docWasChanged();
        this.setSelection( range );
    } else if ( isIOS ) {
        encapsulateNonEditableElements(range, root);
        var clone = cloneRootWithRange(this._root, range);

        // cut selected range
        node.appendChild(deleteContentsOfRange(clone.range, clone.root, true));
        fakeClipboardContent = node.innerHTML;

        setTimeout( function () {
            try {
                self._setHTML(clone.root.innerHTML);
                // If all content removed, ensure div at start of root.
                fixContainer(root, root);
                self._docWasChanged();
            } catch ( error ) {
                self.didError( error );
            }
        }, 0 );
    } else if ( clipboardData ) {
        fakeClipboardContent = node.innerHTML;
        node.appendChild( deleteContentsOfRange( range, root ) );
        clipboardData.setData( 'text/html', node.innerHTML );
        if (clipboardData.types.indexOf('text/html') === -1) {
            clipboardData.setData('text/plain', FAKECLIPBOARD_CONSTANT + (node.innerText || node.textContent));
        } else {
            clipboardData.setData('text/plain', (node.innerText || node.textContent));
        }
        event.preventDefault();
        fixContainer(root, root);
        this._docWasChanged();
        this.setSelection( range );
    } else {
        event.preventDefault();
    }
};

var onCopy = function ( event ) {
    var clipboardData = event.clipboardData;
    var range = this.getSelection();
    var node = this.createElement( 'div' );
    var root = this._root;

    moveRangeBoundariesUpTree( range, root );
    node.appendChild( range.cloneContents() );

    // Edge only seems to support setting plain text as of 2016-03-11.
    // Mobile Safari flat out doesn't work:
    // https://bugs.webkit.org/show_bug.cgi?id=143776
    if (isEdge) {
        fakeClipboardContent = node.innerHTML;
        clipboardData.setData( 'text/plain', FAKECLIPBOARD_CONSTANT + (node.innerText || node.textContent) );
        event.preventDefault();

    } else if (isIOS) {
        fakeClipboardContent = node.innerHTML;
    } else if (clipboardData) {
        fakeClipboardContent = node.innerHTML;
        clipboardData.setData( 'text/html', node.innerHTML );
        if (clipboardData.types.indexOf('text/html') === -1) {
            clipboardData.setData('text/plain', FAKECLIPBOARD_CONSTANT + (node.innerText || node.textContent));
        } else {
            clipboardData.setData('text/plain', (node.innerText || node.textContent));
        }
        event.preventDefault();
    } else {
        event.preventDefault();
    }
};

var onPaste = function ( event ) {
    var clipboardData = event.clipboardData,
        items = clipboardData && clipboardData.items,
        fireDrop = false,
        hasImage = false,
        plainItem = null,
        self = this,
        l, item, type, types, data;

    // Current HTML5 Clipboard interface
    // ---------------------------------
    // https://html.spec.whatwg.org/multipage/interaction.html

    // Edge only provides access to plain text as of 2016-03-11.
    if ( !isIOS && items ) {

        event.preventDefault();
        l = items.length;
        while ( l-- ) {
            item = items[l];
            type = item.type;
            if ( type === 'text/html' ) {
                /*jshint loopfunc: true */
                item.getAsString( function ( html ) {
                    //var temp = document.createElement("div");
                    //temp.innerHTML = html;
                    //var sanitized = temp.textContent || temp.innerText;
                    self.insertHTML( html, true );
                });
                /*jshint loopfunc: false */
                return;
            }
            if ( type === 'text/plain' ) {
                plainItem = item;
            }
            if ( /^image\/.*/.test( type ) ) {
                hasImage = true;
            }
        }
        // Treat image paste as a drop of an image file.
        if ( hasImage ) {
            this.fireEvent( 'dragover', {
                dataTransfer: clipboardData,
                /*jshint loopfunc: true */
                preventDefault: function () {
                    fireDrop = true;
                }
                /*jshint loopfunc: false */
            });
            if ( fireDrop ) {
                this.fireEvent( 'drop', {
                    dataTransfer: clipboardData
                });
            }
        } else if ( plainItem ) {
            plainItem.getAsString( function ( text ) {
                if (fakeClipboardContent && text.indexOf(FAKECLIPBOARD_CONSTANT) === 0) {
                    self.insertHTML(fakeClipboardContent, true);
                } else {
                    fakeClipboardContent = null;
                    self.insertPlainText( text, true );
                }
            });
        }
        return;
    }

    // Old interface
    // -------------

    // Safari (and indeed many other OS X apps) copies stuff as text/rtf
    // rather than text/html; even from a webpage in Safari. The only way
    // to get an HTML version is to fallback to letting the browser insert
    // the content. Same for getting image data. *Sigh*.
    //
    // Firefox is even worse: it doesn't even let you know that there might be
    // an RTF version on the clipboard, but it will also convert to HTML if you
    // let the browser insert the content. I've filed
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1254028
    types = clipboardData && clipboardData.types;
    if ( /*!isEdge &&*/ types && (
            indexOf.call( types, 'text/html' ) > -1 || (
                !isGecko &&
                indexOf.call( types, 'text/plain' ) > -1 &&
                indexOf.call( types, 'text/rtf' ) < 0 )
            )) {
        event.preventDefault();
        // Abiword on Linux copies a plain text and html version, but the HTML
        // version is the empty string! So always try to get HTML, but if none,
        // insert plain text instead. On iOS, Facebook (and possibly other
        // apps?) copy links as type text/uri-list, but also insert a **blank**
        // text/plain item onto the clipboard. Why? Who knows.
        if (( data = clipboardData.getData( 'text/html' ) )) {
            this.insertHTML( data, true );
        } else if (
                ( data = clipboardData.getData( 'text/plain' ) ) ||
                ( data = clipboardData.getData( 'text/uri-list' ) ) ) {
            if (fakeClipboardContent && (isIOS || data.indexOf(FAKECLIPBOARD_CONSTANT) === 0)) {
                self.insertHTML(fakeClipboardContent, true);
            } else {
                fakeClipboardContent = null;
                self.insertPlainText( data, true );
            }
        }
        return;
    }

    // No interface. Includes all versions of IE :(
    // --------------------------------------------

    this._awaitingPaste = true;

    var body = this._doc.body,
        range = this.getSelection(),
        startContainer = range.startContainer,
        startOffset = range.startOffset,
        endContainer = range.endContainer,
        endOffset = range.endOffset;

    // We need to position the pasteArea in the visible portion of the screen
    // to stop the browser auto-scrolling.
    var pasteArea = this.createElement( 'DIV', {
        contenteditable: 'true',
        style: 'position:fixed; overflow:hidden; top:0; right:100%; width:1px; height:1px;'
    });
    body.appendChild( pasteArea );
    range.selectNodeContents( pasteArea );
    this.setSelection( range );

    // A setTimeout of 0 means this is added to the back of the
    // single javascript thread, so it will be executed after the
    // paste event.
    setTimeout( function () {
        try {
            // IE sometimes fires the beforepaste event twice; make sure it is
            // not run again before our after paste function is called.
            self._awaitingPaste = false;

            // Get the pasted content and clean
            var html = '',
                next = pasteArea,
                first, range;

            // #88: Chrome can apparently split the paste area if certain
            // content is inserted; gather them all up.
            while ( pasteArea = next ) {
                next = pasteArea.nextSibling;
                detach( pasteArea );
                // Safari and IE like putting extra divs around things.
                first = pasteArea.firstChild;
                if ( first && first === pasteArea.lastChild &&
                        first.nodeName === 'DIV' ) {
                    pasteArea = first;
                }
                html += pasteArea.innerHTML;
            }

            range = self._createRange(
                startContainer, startOffset, endContainer, endOffset );
            self.setSelection( range );

            if ( html ) {
                self.insertHTML( html, true );
            }
        } catch ( error ) {
            self.didError( error );
        }
    }, 0 );
};

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

if ( typeof exports === 'object' ) {
    module.exports = Squire;
} else if ( typeof define === 'function' && define.amd ) {
    define( function () {
        return Squire;
    });
} else {
    win.Squire = Squire;

    if ( top !== win &&
            doc.documentElement.getAttribute( 'data-squireinit' ) === 'true' ) {
        win.editor = new Squire( doc );
        if ( win.onEditorLoad ) {
            win.onEditorLoad( win.editor );
            win.onEditorLoad = null;
        }
    }
}

}( document ) );
