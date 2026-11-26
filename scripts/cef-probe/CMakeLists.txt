cmake_minimum_required(VERSION 3.21)
project(FrankFramesCefProbe LANGUAGES CXX)
if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "A sonda requer Windows x64")
endif()
foreach(sdk CEF_ROOT VULKAN_HEADERS FFMPEG_SDK)
  if(NOT IS_DIRECTORY "${${sdk}}")
    message(FATAL_ERROR "Informe -D${sdk}=<pasta do SDK>")
  endif()
endforeach()
set(USE_SANDBOX OFF CACHE BOOL "")
list(APPEND CMAKE_MODULE_PATH "${CEF_ROOT}/cmake")
find_package(CEF REQUIRED)
add_subdirectory("${CEF_LIBCEF_DLL_WRAPPER_PATH}" libcef_dll_wrapper)
ADD_LOGICAL_TARGET(libcef_lib "${CEF_LIB_DEBUG}" "${CEF_LIB_RELEASE}")
add_executable(ff-cef-probe probe-win.cc)
SET_EXECUTABLE_TARGET_PROPERTIES(ff-cef-probe)
target_include_directories(ff-cef-probe PRIVATE "${CEF_ROOT}" "${VULKAN_HEADERS}/include" "${FFMPEG_SDK}/include")
target_link_libraries(ff-cef-probe PRIVATE libcef_lib libcef_dll_wrapper ${CEF_STANDARD_LIBS} d3d11 dxgi
  "${FFMPEG_SDK}/lib/avfilter.lib" "${FFMPEG_SDK}/lib/avutil.lib")
file(GLOB ffmpeg_dlls "${FFMPEG_SDK}/bin/*.dll")
add_custom_command(TARGET ff-cef-probe POST_BUILD
  COMMAND "${CMAKE_COMMAND}" -E copy_directory "${CEF_BINARY_DIR_RELEASE}" "$<TARGET_FILE_DIR:ff-cef-probe>"
  COMMAND "${CMAKE_COMMAND}" -E copy_directory "${CEF_RESOURCE_DIR}" "$<TARGET_FILE_DIR:ff-cef-probe>"
  COMMAND "${CMAKE_COMMAND}" -E copy_if_different ${ffmpeg_dlls} "$<TARGET_FILE_DIR:ff-cef-probe>"
  VERBATIM)
