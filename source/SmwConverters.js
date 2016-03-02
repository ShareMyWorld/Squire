/*jshint strict:false, undef:false, unused:false */
function SmwConverters ( ) {

}

var proto = SmwConverters.prototype;

proto.converters = [
	{
		filter: function (node) {
			var parent = node.parentNode;
			// ignore header p
		 	return node.nodeName === 'P' && 
		 	 (parent.nodeName[0] !== 'H' && parent.nodeName !== 'BLOCKQUOTE');
		},
		replacement: function(content) {
			return '\n\n' + content + '\n\n';
		}
	},
	{
		filter: 'p',
		replacement: function(content) {
          return content;
        }
	},
	{
		filter: 'i',
		replacement: function(content) {
          return '//' + content + '//';
        }
	},
	{
		filter: function (node) {
			var parent = node.parentNode;
		 	return node.nodeName === 'LI' && parent.nodeName && /marked-no-list-labels/i.test(parent.className);
		},
		replacement: function(content) {
			return '- ' + content;
		}
	},
	{
		filter: function (node) {
		 	return node.nodeName === 'IMG' && /page-break/i.test(node.className);
		},
		replacement: function(content) {
			return '---';
		}
	},
	{
		filter: 'blockquote',
		replacement: function(content) {
			return '""' + content + '""'; 
		}
	},
	{
		filter: 'br',
		replacement: function(content) {
			return '\n'; 
		}
	}


];