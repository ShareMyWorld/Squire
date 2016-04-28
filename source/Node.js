/*jshint strict:false, undef:false, unused:false */

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
    return ( type === ELEMENT_NODE || type === DOCUMENT_FRAGMENT_NODE ) &&
        !isInline( node ) && every( node.childNodes, isInline );
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

function fixBlocks( node, squire, doc, config ) {
    var nodeInsertedBefore = false;
    if ( node.nodeName === 'P' ) {
        fixParagraph( node, node.parentNode, squire, doc );
    } else {
        var smwNode = squire._translateToSmw[ getFullNodeName( node ) ];
        var classification = squire._allowedContent[ smwNode ];
                
        if ( classification === 'blockAtomic' ) {
            //No children allowed, remove all children
            while ( node.firstChild ) {
                node.removeChild( node.firstChild );
            }
        } else {
            //Only one p allowed! 
            var p = filterParagraphs( node, doc, config );
            fixParagraph( p, node, squire, doc );
        }
        nodeInsertedBefore = fixStaticBlocks( node, squire, doc, config );
    }

    return nodeInsertedBefore;
}


function filterParagraphs( node, doc, config ) {
    var children = Array.prototype.slice.call(node.childNodes),
            child;

    var p = node.querySelector('P');
    if ( !p ) {
        p = createElement( doc, config.blockTag, config.blockAttributes );
        var textNode = doc.createTextNode( node.textContent );
        p.appendChild( textNode );
        while ( node.firstChild ) {
            node.removeChild( node.firstChild );
        }
        node.appendChild( p );

    } else {
        var text = children.reduce( function( acc, child ){
            if ( child !== p ) {
                acc += child.textContent;
                detach( child );
            } 
            return acc
        }, "");
        var textNode = doc.createTextNode( text );
        p.appendChild( textNode );
    }
    return p;
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

            if ( !isInline( child ) || ( smwParent && !squire.isAllowedIn( squire, smwChild, smwParent ) ) ) {
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

            } else if ( isFirstCascadingChild && child === node.firstChild ) {
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

function isBlockAllowedIn( _node, _container, squire, config ) {
    var smwNode = squire._translateToSmw[ getFullNodeName( _node ) ];
    var smwContainer = squire._translateToSmw[ getFullNodeName( _container ) ];
    var containerTag = smwContainer !== undefined ? smwContainer : _container.nodeName.toLowerCase();
    var allowed = squire._allowedBlocksForContainers[ containerTag ];
    
    if ( _node.nodeName === 'P' ) {
        return true;
    } else if ( _node.nodeName === 'LI' ) {
        return /^[OU]L$/.test( _container.nodeName );
    } else if ( allowed ) {
        return allowed.indexOf( smwNode ) !== -1;
    } else {
        return false;
    }
}

function getFullNodeName( node ) {
    var c;
    if ( c = node.getAttribute( 'class' ) ){
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
        wrapper = null,
        i, l, child, isBR,
        squire = getSquireInstance( doc ),
        config = squire._config;

    for ( i = 0, l = children.length; i < l; i += 1 ) {
        child = children[i];
        isBR = child.nodeName === 'BR';
        if ( !isBR && isInline( child ) ) {
            if ( !wrapper ) {
                 wrapper = createElement( doc,
                    config.blockTag, config.blockAttributes );
            }
            wrapper.appendChild( child );
            i -= 1;
            l -= 1;
        } else if ( isBR || wrapper ) {
            if ( !wrapper ) {
                wrapper = createElement( doc,
                    config.blockTag, config.blockAttributes );
            }
            if ( isBR ) {
                container.replaceChild( wrapper, child );
            } else {
                container.insertBefore( wrapper, child );
                i += 1;
                l += 1;
            }
            fixParagraph( wrapper, container, squire, doc );
            wrapper = null;
        } else if ( getFullNodeName( child ) === 'BLOCKQUOTE.aside' ) {
            //continue further down the tree
        } else if ( !child.isContentEditable || container.getAttribute('contenteditable') === 'false' ) {
            //Don't check this child
        } else if ( /^[OU]L$/.test( child.nodeName ) ) {
            var listChildren = Array.prototype.slice.call( child.childNodes );
            listChildren.forEach(function(c){
                if ( c.nodeName !== 'LI' ) {
                    var liWrapper = createElement( doc, 'LI' );
                    var p = createElement( doc,
                        config.blockTag, config.blockAttributes );
                    p.appendChild( empty( c ));
                    liWrapper.appendChild( p );
                    child.replaceChild( liWrapper, c );
                }
            });

        } else if ( isBlockAllowedIn( child, container, squire, config ) ) {
            if ( fixBlocks( child, squire, doc, config ) ) {
                i += 1;
                l += 1;
            }
        } else {
            wrapper = createElement( doc, config.blockTag, config.blockAttributes );
            wrapper.appendChild( empty( child ) );
            container.replaceChild( wrapper, child );
            fixParagraph( wrapper, container, squire, doc );
            wrapper = null;
        }
        if ( fixStaticBlocks( child, squire, doc, config ) ) {
                i += 1;
                l += 1;
        }
        if ( isContainer( child ) && child.nodeName !== 'LI' && child.isContentEditable ) {
            fixContainer( child, root );
        }
        
    }
    if ( container === root || ( isContainer( container ) && !/^[OU]L$/.test( container.nodeName ) ) ) {
        squire._ensureBottomLine( container );
    }

    if ( wrapper ) {
        fixParagraph( wrapper, container, squire, doc );
        container.appendChild( wrapper );
    }
    return container;
}

function fixStaticBlocks( node, squire, doc, config ) {
    var classification = getStaticClassification( node );
    var isStatic = classification === 'blockAtomic' || classification === 'containers'; 
    
    var previous = node.previousSibling || node.parentNode;
    var nodeInsertedBefore = false;
    if ( isStatic ) {
        var prevClassification = getStaticClassification( previous );
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

function getStaticClassification( node ) {
    var name = getFullNodeName( node );
    var smwNode = squire._translateToSmw[ name ];
    var classification = squire._allowedContent[ smwPrevious ];

    if ( !classification && 
         ( name === 'BODY' || name === 'P.page-break-container' ) ) {
            //the hr container is not classified as hr, lets fake that it should be fixed
            classification = 'containers';
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

function mergeInlines ( node, range ) {
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
            if ( range.startContainer === child ) {
                range.startContainer = prev;
                range.startOffset += getLength( prev );
            }
            if ( range.endContainer === child ) {
                range.endContainer = prev;
                range.endOffset += getLength( prev );
            }
            if ( range.startContainer === node ) {
                if ( range.startOffset > l ) {
                    range.startOffset -= 1;
                }
                else if ( range.startOffset === l ) {
                    range.startContainer = prev;
                    range.startOffset = getLength( prev );
                }
            }
            if ( range.endContainer === node ) {
                if ( range.endOffset > l ) {
                    range.endOffset -= 1;
                }
                else if ( range.endOffset === l ) {
                    range.endContainer = prev;
                    range.endOffset = getLength( prev );
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
            mergeInlines( child, range );
        }
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
    mergeInlines( block, _range );

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
