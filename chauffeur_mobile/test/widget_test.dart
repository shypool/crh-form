import 'package:flutter_test/flutter_test.dart';

import 'package:chauffeur_mobile/main.dart';

void main() {
  testWidgets('App renders chauffeur title', (WidgetTester tester) async {
    await tester.pumpWidget(const CarTrackingApp());
    expect(find.text('Car Tracking'), findsOneWidget);
  });
}
