from __future__ import annotations

import unittest

import jamu_translate as jt


class TranslationHelpersTest(unittest.TestCase):
    def test_visible_segments_preserve_wordpress_comments_and_shortcodes(self):
        markup = '<!-- wp:paragraph --><p>Ahoj <strong>světe</strong>.</p><!-- /wp:paragraph -->\n[woocommerce_checkout]'
        self.assertEqual(['Ahoj', 'světe'], [segment.strip(' .') for segment in jt.visible_segments(markup)])

    def test_slugify_handles_german_and_polish_characters(self):
        self.assertEqual('massage-und-gesundheit', jt.slugify('Massage und Gesundheit'))
        self.assertEqual('zdrowie-i-pielegnacja', jt.slugify('Zdrowie i pielęgnacja'))

    def test_routes_do_not_mix_post_and_term_parents_with_same_id(self):
        rows = [
            {'object_type': 'post', 'object_subtype': 'page', 'object_id': 1, 'parent': 0, '_translated_title': 'Parent page'},
            {'object_type': 'post', 'object_subtype': 'page', 'object_id': 2, 'parent': 1, '_translated_title': 'Child page'},
            {'object_type': 'term', 'object_subtype': 'product_cat', 'object_id': 1, 'parent': 0, '_translated_title': 'Root term'},
            {'object_type': 'term', 'object_subtype': 'product_cat', 'object_id': 2, 'parent': 1, '_translated_title': 'Child term'},
        ]
        routes = jt.unique_routes(rows, 'en')
        self.assertEqual('parent-page/child-page', routes[('post', 2)])
        self.assertEqual('root-term/child-term', routes[('term', 2)])

    def test_wpforms_choices_accept_lists_and_id_keyed_objects(self):
        expected = [{'label': 'Praha', 'value': 'praha'}]
        self.assertEqual(expected, jt.choice_values(expected))
        self.assertEqual(expected, jt.choice_values({'1': expected[0]}))
        self.assertEqual([], jt.choice_values('invalid'))


if __name__ == '__main__':
    unittest.main()
