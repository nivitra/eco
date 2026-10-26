import Foundation
import Vision
import ImageIO
let args=CommandLine.arguments
let feed=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:args[1]))) as! [String:Any]
let rows=feed["items"] as! [[String:Any]]
let folder=URL(fileURLWithPath:args[2])
let categories=["starters","main course","soups","beverages","milkshakes","sandwiches","burgers","pizzas","pastas","mocktails","salads","desserts","non veg","veg starters","hot coffee","cold coffee"]
let prices=try NSRegularExpression(pattern:"\\b[0-9]{2,4}(?:\\.[0-9]{1,2})?\\b")
var rejected=[String:String]()
var checks=[[String:Any]]()
for row in rows {
 autoreleasepool {
  guard let hash=row["sha256"] as? String else{return}
  let file=folder.appendingPathComponent(hash+".webp")
  do {
   let request=VNRecognizeTextRequest()
   request.recognitionLevel = .fast
   request.recognitionLanguages=["en-US"]
   request.usesLanguageCorrection=false
   request.minimumTextHeight=0.02
   try VNImageRequestHandler(url:file,options:[:]).perform([request])
   let text=(request.results ?? []).compactMap{$0.topCandidates(1).first?.string}.joined(separator:" ").lowercased()
   let headings=categories.filter{text.contains($0)}
   let numbers=prices.numberOfMatches(in:text,range:NSRange(text.startIndex...,in:text))
   let menu=(headings.count>=4 && numbers>=5)||(text.contains("menu") && headings.count>=2 && numbers>=3)
   if menu {rejected[hash]="OCR found menu headings and price columns; unsuitable as a venue hero photo."}
   checks.append(["placeID":row["placeID"] ?? "","sha256":hash,"menuHeadings":headings,"numericItems":numbers,"heldAsMenu":menu])
  } catch {checks.append(["placeID":row["placeID"] ?? "","error":"Local OCR unavailable for this image"])}
 }
}
let result:[String:Any] = ["rejectedHashes":rejected,"checks":checks]
try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:URL(fileURLWithPath:args[3]))
print("OCR checked \(checks.count) selected photos; held \(rejected.count) menu images.")
