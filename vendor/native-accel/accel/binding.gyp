{
  'variables': {
    'openssl_fips': ''
  },
  'targets': [
    {
      'target_name': 'accel',
      'sources': ['src/accel.c'],
      'cflags': ['-std=c99'],
      'conditions': [
        ["OS=='mac'", {
          'xcode_settings': {
            'MACOSX_DEPLOYMENT_TARGET': '10.7'
          }
        }]
      ]
    }
  ]
}
