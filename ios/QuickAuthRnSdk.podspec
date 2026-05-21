require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'QuickAuthRnSdk'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = 'https://quickauth.in'
  s.license      = { :type => 'MIT' }
  s.authors      = { 'QuickAuth' => 'contact@quickauth.in' }
  s.platforms    = { :ios => '12.0' }
  s.source       = { :git => 'https://github.com/quickauthin/quickauth-sdk-react-native.git', :tag => "v#{s.version}" }

  s.source_files = 'QuickAuthRnSdk.{h,m}'
  s.requires_arc = true

  s.dependency 'React-Core'
end
