/**
 * Is this `.h` an Objective-C header? The extension is shared by C, C++ and Objective-C and has one owner (the
 * C++ plugin), so that plugin hands a header over from its `preprocess` when the text says so: an `@interface`,
 * `@protocol`, `@implementation`, `@class` or `@property` line, or an import of a system framework
 * (`#import <Foundation/Foundation.h>`). A plain C or C++ header has none of them.
 */
const OBJC_HEADER = /^[ \t]*(?:@(?:interface|protocol|implementation|class|property|end)\b|#\s*import\s*<(?:Foundation|UIKit|AppKit|CoreData|CoreGraphics|CoreFoundation|QuartzCore|AVFoundation|MapKit|WebKit|Security|Cocoa)\/)/m;

export function isObjcHeader(relativePath: string, source: string): boolean {
  return /\.h$/i.test(relativePath) && OBJC_HEADER.test(source);
}
