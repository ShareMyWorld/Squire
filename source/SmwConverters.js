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
		 	 (parent.nodeName[0] !== 'H' && parent.nodeName !== 'LI' && parent.nodeName !== 'BLOCKQUOTE');
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
		filter: 'span',
		replacement: function(content) {
          return content;
        }
	},
	{
		filter: 'div',
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
		 	return node.nodeName === 'LI' && parent.nodeName === 'UL' && parent.classList.contains('marked-no-list-labels');
		},
		replacement: function(content) {
			return '- ' + content.trim().replace(/\n/g, '\n  ');
		}
	},
	{
		filter: function (node) {
			var parent = node.parentNode;
		 	return node.nodeName === 'LI' && parent.nodeName === 'UL' && !parent.classList.contains('marked-no-list-labels');
		},
		replacement: function(content) {
			return '* ' + content.trim().replace(/\n/g, '\n  ');
		}
	},
	{
		filter: function (node) {
		 	return node.nodeName === 'OL';
		},
		replacement: function(content) {
			//To keep the numbered bullet we manually fitler li:s
			var lis = content.split('\n');
			var formatted = lis.map(function(li){
				var trimmedLi = li.trim();
				if (trimmedLi.match('^\d+'))
					return trimmedLi.replace(/\s+/, ' ');
				else
					return '  ' + trimmedLi;
			});
			return formatted.join('\n') + '\n';
		}
	},
	{
		filter: function (node) {
		 	return node.nodeName === 'IMG' && node.classList.contains('page-break');
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
		filter: function (node){
			return node.nodeName === 'BR' && node.parentNode.nodeName !== 'LI';
		},
		replacement: function(content) {
			return '\n'; 
		}
	}


];